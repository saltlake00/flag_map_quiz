// -*- coding: utf-8 -*-
/**
 * net.js
 * 국기·지도 찾기 멀티플레이 네트워크 어댑터
 * abstract_quiz/js/net.js를 그대로 가져와 토픽·저장 키 이름만 바꿨다. 동작을 고치면 두 레포를 같이 고친다.
 *
 * 지원 채널 (동시 구동 및 메시지 ID 중복 제거):
 * 1. MQTT over WSS (wss://broker.emqx.io:8084/mqtt) : LTE/방화벽/공유기 격리 환경을 100% 통과하는 실시간 웹소켓 중계
 * 2. PeerJS (WebRTC 무료 클라우드 브로커) : 기기 간 직접 P2P 데이터 채널 연결
 * 3. BroadcastChannel : 동일 기기 내 다중 브라우저 탭 간 0ms 즉시 동기화
 * 4. Firebase Realtime Database (선택 설정) : 설정 모달에 databaseURL 입력 시 병행 작동
 *
 * 보안 및 방 관리:
 * - 호스트 권위(Authoritative Host) 구조
 * - 방 비밀번호 해시(hashRoomPassword) 대조를 통한 입장 승인(AUTH_OK) / 거부(AUTH_FAIL)
 */

(function (global) {
  "use strict";

  const PEER_PREFIX = "fmq_v1_room_";
  const BC_PREFIX = "fmq_bc_";
  const MQTT_BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
  ];
  const TOPIC_PREFIX = "fmq_v1_net";

  class RoomNetwork {
    constructor(callbacks = {}) {
      this.callbacks = callbacks;
      this.isHost = false;
      this.roomCode = "";
      this.passwordHash = "";
      this.hasPassword = false;
      this.myId = this._loadOrCreateClientId();
      this.myNick = "";

      this.peer = null;
      this.hostConn = null;
      this.guestConns = new Map();
      this.mqttClient = null;
      this.bc = null;
      this.fbUrl = localStorage.getItem("fmq_firebase_url") || "";
      this.fbPollTimer = null;
      this.joinRetryTimer = null;
      this.joinTimeout = null;
      this.connected = false;
      this.seenMsgIds = new Set();
    }

    _loadOrCreateClientId() {
      let id = sessionStorage.getItem("fmq_client_id");
      if (!id) {
        id = "u_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now().toString(36).slice(-4);
        sessionStorage.setItem("fmq_client_id", id);
      }
      return id;
    }

    _stampMsg(payload) {
      return {
        ...payload,
        _mid: payload._mid || `${this.myId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        senderId: this.myId,
      };
    }

    _isDuplicate(data) {
      if (!data || !data._mid) return false;
      if (this.seenMsgIds.has(data._mid)) return true;
      this.seenMsgIds.add(data._mid);
      if (this.seenMsgIds.size > 600) {
        const first = this.seenMsgIds.values().next().value;
        this.seenMsgIds.delete(first);
      }
      return false;
    }

    setFirebaseUrl(url) {
      this.fbUrl = (url || "").trim().replace(/\/+$/, "");
      if (this.fbUrl) {
        localStorage.setItem("fmq_firebase_url", this.fbUrl);
      } else {
        localStorage.removeItem("fmq_firebase_url");
      }
    }

    /**
     * 호스트로서 새 방을 생성한다.
     */
    createRoom({ roomCode, nick, password }) {
      this.disconnect();
      this.isHost = true;
      this.roomCode = String(roomCode).toUpperCase().trim();
      this.myNick = nick.trim();
      this.passwordHash = global.GameEngine.hashRoomPassword(password, this.roomCode);
      this.hasPassword = Boolean(this.passwordHash);

      // 1. 로컬 다중 탭 BroadcastChannel 오픈
      this._initBroadcastChannel();

      // 2. MQTT over WSS 실시간 중계 채널 연결 (LTE/다른 와이파이 즉시 연결 보장)
      this._initMqttHost();

      // 3. 선택적 Firebase 방 메타 등록
      if (this.fbUrl) {
        this._fbPut(`/rooms/${this.roomCode}/meta.json`, {
          roomCode: this.roomCode,
          hasPassword: this.hasPassword,
          hostId: this.myId,
          createdAt: Date.now(),
        });
        this._startFirebasePolling();
      }

      // 4. PeerJS 클라우드 브로커에 방 ID 등록
      if (typeof global.Peer !== "undefined") {
        const peerId = PEER_PREFIX + this.roomCode;
        try {
          this.peer = new global.Peer(peerId, {
            debug: 0,
            config: {
              iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" },
              ],
            },
          });

          this.peer.on("open", () => {
            this.connected = true;
            this._emitStatus("online", "온라인 멀티 방 활성화됨");
          });

          this.peer.on("connection", (conn) => {
            conn.on("data", (data) => {
              this._handleIncomingOnHost(
                data,
                (reply) => {
                  const stamped = this._stampMsg(reply);
                  try {
                    conn.send(stamped);
                  } catch (e) {}
                  this._publishMqtt(`${TOPIC_PREFIX}/${this.roomCode}/direct/${data.uid}`, stamped);
                },
                conn
              );
            });
            conn.on("close", () => {
              const uid = conn._fmqUid;
              if (uid) {
                this.guestConns.delete(uid);
                if (this.callbacks.onPeerLeave) this.callbacks.onPeerLeave(uid);
              }
            });
          });

          this.peer.on("error", () => {});
        } catch (e) {}
      }

      this.connected = true;
      if (this.callbacks.onHostReady) {
        this.callbacks.onHostReady({
          roomCode: this.roomCode,
          hasPassword: this.hasPassword,
          hostId: this.myId,
          nick: this.myNick,
        });
      }
    }

    /**
     * 게스트로서 기존 방에 입장을 요청한다.
     */
    joinRoom({ roomCode, nick, password }) {
      this.disconnect();
      this.isHost = false;
      this.roomCode = String(roomCode).toUpperCase().trim();
      this.myNick = nick.trim();
      this.passwordHash = global.GameEngine.hashRoomPassword(password, this.roomCode);

      let authResolved = false;

      const buildJoinPacket = () =>
        this._stampMsg({
          type: "JOIN_REQ",
          uid: this.myId,
          nick: this.myNick,
          passwordHash: this.passwordHash,
          ts: Date.now(),
        });

      const onGuestPacket = (msg) => {
        if (!msg || (msg.targetUid && msg.targetUid !== this.myId)) return;
        if (msg.type === "AUTH_OK" || msg.type === "AUTH_FAIL") {
          authResolved = true;
          this._clearJoinTimers();
        }
        this._handleIncomingOnGuest(msg);
      };

      // 1. BroadcastChannel 즉시 탐색
      this._initBroadcastChannel(onGuestPacket);
      this._sendViaBroadcastChannel(buildJoinPacket());

      // 2. MQTT over WSS 연결 및 입장 요청 전송
      this._initMqttGuest(onGuestPacket, () => {
        if (!authResolved) {
          this._publishMqtt(`${TOPIC_PREFIX}/${this.roomCode}/inbox`, buildJoinPacket());
        }
      });

      // 3. 선택적 Firebase 경유 입장
      if (this.fbUrl) {
        this._fbPost(`/rooms/${this.roomCode}/inbox.json`, buildJoinPacket());
        this._startFirebasePolling();
      }

      // 4. PeerJS (WebRTC) 원격 호스트 연결
      if (typeof global.Peer !== "undefined") {
        try {
          this.peer = new global.Peer({
            debug: 0,
            config: {
              iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" },
              ],
            },
          });

          this.peer.on("open", () => {
            if (authResolved) return;
            const targetPeerId = PEER_PREFIX + this.roomCode;
            const conn = this.peer.connect(targetPeerId, { reliable: true });
            this.hostConn = conn;

            conn.on("open", () => {
              if (!authResolved) {
                conn.send(buildJoinPacket());
              }
            });

            conn.on("data", (data) => onGuestPacket(data));
            conn.on("error", () => {});
          });

          this.peer.on("error", () => {});
        } catch (e) {}
      }

      // 1.8초 간격 재시도 (네트워크 연결 직후 패킷 유실 대비)
      this.joinRetryTimer = setInterval(() => {
        if (authResolved) {
          this._clearJoinTimers();
          return;
        }
        const pkt = buildJoinPacket();
        this._sendViaBroadcastChannel(pkt);
        this._publishMqtt(`${TOPIC_PREFIX}/${this.roomCode}/inbox`, pkt);
        if (this.hostConn && this.hostConn.open) {
          try {
            this.hostConn.send(pkt);
          } catch (e) {}
        }
      }, 1800);

      // 9초 내 응답이 없으면 타임아웃 안내
      this.joinTimeout = setTimeout(() => {
        this._clearJoinTimers();
        if (!authResolved) {
          this._emitError(
            "방 코드(" +
              this.roomCode +
              ")에 응답하는 방장이 없습니다. 방 코드가 맞는지, 방장이 대기실을 열어 두었는지 확인해 주세요."
          );
        }
      }, 9000);
    }

    _clearJoinTimers() {
      if (this.joinRetryTimer) {
        clearInterval(this.joinRetryTimer);
        this.joinRetryTimer = null;
      }
      if (this.joinTimeout) {
        clearTimeout(this.joinTimeout);
        this.joinTimeout = null;
      }
    }

    _initMqttHost() {
      if (typeof global.mqtt === "undefined") return;
      try {
        const client = global.mqtt.connect(MQTT_BROKERS[0], {
          connectTimeout: 5000,
          reconnectPeriod: 2000,
        });
        this.mqttClient = client;
        const inboxTopic = `${TOPIC_PREFIX}/${this.roomCode}/inbox`;

        client.on("connect", () => {
          this._emitStatus("online", "온라인 클라우드 연결됨");
          client.subscribe(inboxTopic);
        });

        client.on("message", (topic, payloadBuf) => {
          try {
            const data = JSON.parse(payloadBuf.toString());
            if (!data || data.senderId === this.myId) return;
            this._handleIncomingOnHost(data, (reply) => {
              const stamped = this._stampMsg({ ...reply, targetUid: data.uid });
              this._publishMqtt(`${TOPIC_PREFIX}/${this.roomCode}/direct/${data.uid}`, stamped);
            });
          } catch (e) {}
        });
      } catch (e) {}
    }

    _initMqttGuest(onGuestPacket, onConnected) {
      if (typeof global.mqtt === "undefined") return;
      try {
        const client = global.mqtt.connect(MQTT_BROKERS[0], {
          connectTimeout: 5000,
          reconnectPeriod: 2000,
        });
        this.mqttClient = client;
        const directTopic = `${TOPIC_PREFIX}/${this.roomCode}/direct/${this.myId}`;
        const broadcastTopic = `${TOPIC_PREFIX}/${this.roomCode}/broadcast`;

        client.on("connect", () => {
          client.subscribe([directTopic, broadcastTopic], () => {
            if (onConnected) onConnected();
          });
        });

        client.on("message", (topic, payloadBuf) => {
          try {
            const data = JSON.parse(payloadBuf.toString());
            if (!data || data.senderId === this.myId) return;
            onGuestPacket(data);
          } catch (e) {}
        });
      } catch (e) {}
    }

    _publishMqtt(topic, obj) {
      if (!this.mqttClient || !this.mqttClient.connected) return;
      try {
        this.mqttClient.publish(topic, JSON.stringify(obj));
      } catch (e) {}
    }

    _initBroadcastChannel(guestHandler) {
      if (typeof BroadcastChannel === "undefined") return;
      try {
        this.bc = new BroadcastChannel(BC_PREFIX + this.roomCode);
        this.bc.onmessage = (ev) => {
          const data = ev.data;
          if (!data || data.senderId === this.myId) return;
          if (this.isHost) {
            this._handleIncomingOnHost(data, (reply) => {
              const stamped = this._stampMsg({ ...reply, targetUid: data.uid });
              this._sendViaBroadcastChannel(stamped);
            });
          } else if (guestHandler) {
            guestHandler(data);
          }
        };
      } catch (e) {}
    }

    _sendViaBroadcastChannel(payload) {
      if (!this.bc) return;
      try {
        this.bc.postMessage(payload);
      } catch (e) {}
    }

    _handleIncomingOnHost(data, replyFn, peerConn = null) {
      if (!data || !data.type) return;
      if (this._isDuplicate(data)) return;

      if (data.type === "JOIN_REQ") {
        if (this.hasPassword && data.passwordHash !== this.passwordHash) {
          replyFn({
            type: "AUTH_FAIL",
            uid: data.uid,
            needPassword: true,
            reason: data.passwordHash
              ? "방 비밀번호가 일치하지 않습니다."
              : "🔒 비밀번호가 설정된 방입니다. 비밀번호를 입력해 주세요.",
          });
          return;
        }

        if (peerConn) {
          peerConn._fmqUid = data.uid;
          this.guestConns.set(data.uid, peerConn);
        }

        if (this.callbacks.onJoinRequest) {
          const result = this.callbacks.onJoinRequest({
            uid: data.uid,
            nick: data.nick,
          });
          if (result && result.ok === false) {
            replyFn({
              type: "AUTH_FAIL",
              uid: data.uid,
              needPassword: false,
              reason: result.reason || "입장할 수 없습니다.",
            });
            return;
          }
          replyFn({
            type: "AUTH_OK",
            uid: data.uid,
            roomCode: this.roomCode,
            hasPassword: this.hasPassword,
            state: result ? result.state : null,
          });
        }
        return;
      }

      if (this.callbacks.onHostMessage) {
        this.callbacks.onHostMessage(data);
      }
    }

    _handleIncomingOnGuest(data) {
      if (!data || !data.type) return;
      if (data.targetUid && data.targetUid !== this.myId) return;
      if (this._isDuplicate(data)) return;

      if (data.type === "AUTH_FAIL") {
        this._clearJoinTimers();
        if (this.callbacks.onAuthFail) {
          this.callbacks.onAuthFail(data);
        }
        return;
      }

      if (data.type === "AUTH_OK") {
        this._clearJoinTimers();
        this.connected = true;
        this._emitStatus("online", "온라인 방 연결됨");
        if (this.callbacks.onAuthOk) {
          this.callbacks.onAuthOk(data);
        }
        return;
      }

      if (this.callbacks.onGuestMessage) {
        this.callbacks.onGuestMessage(data);
      }
    }

    /**
     * 호스트가 모든 참가자에게 상태 또는 이벤트를 브로드캐스트한다.
     */
    broadcastFromHost(payload) {
      if (!this.isHost) return;
      const stamped = this._stampMsg(payload);
      this._sendViaBroadcastChannel(stamped);
      this._publishMqtt(`${TOPIC_PREFIX}/${this.roomCode}/broadcast`, stamped);
      for (const [, conn] of this.guestConns.entries()) {
        try {
          if (conn.open) conn.send(stamped);
        } catch (e) {}
      }
      if (this.fbUrl && payload.type === "STATE_SYNC") {
        this._fbPut(`/rooms/${this.roomCode}/state.json`, {
          ...stamped,
          updatedAt: Date.now(),
        });
      }
    }

    /**
     * 게스트(또는 호스트 자신)가 호스트에게 액션(레디, 채팅/정답 제출 등)을 전송한다.
     */
    sendToHost(payload) {
      const msg = this._stampMsg({
        ...payload,
        uid: this.myId,
        nick: this.myNick,
        ts: Date.now(),
      });
      if (this.isHost) {
        if (this.callbacks.onHostMessage) {
          this.callbacks.onHostMessage(msg);
        }
        return;
      }
      this._sendViaBroadcastChannel(msg);
      this._publishMqtt(`${TOPIC_PREFIX}/${this.roomCode}/inbox`, msg);
      if (this.hostConn && this.hostConn.open) {
        try {
          this.hostConn.send(msg);
        } catch (e) {}
      }
      if (this.fbUrl) {
        this._fbPost(`/rooms/${this.roomCode}/inbox.json`, msg);
      }
    }

    async _fbPut(path, body) {
      if (!this.fbUrl) return;
      try {
        await fetch(this.fbUrl + path, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {}
    }

    async _fbPost(path, body) {
      if (!this.fbUrl) return;
      try {
        await fetch(this.fbUrl + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {}
    }

    _startFirebasePolling() {
      if (!this.fbUrl) return;
      if (this.fbPollTimer) clearInterval(this.fbPollTimer);
      let lastSeenTs = Date.now() - 2000;

      this.fbPollTimer = setInterval(async () => {
        if (!this.roomCode || !this.fbUrl) return;
        try {
          if (this.isHost) {
            const res = await fetch(`${this.fbUrl}/rooms/${this.roomCode}/inbox.json`);
            if (!res.ok) return;
            const inbox = await res.json();
            if (!inbox) return;
            for (const key of Object.keys(inbox)) {
              const item = inbox[key];
              if (item && item.ts > lastSeenTs) {
                lastSeenTs = item.ts;
                this._handleIncomingOnHost(item, (reply) => {
                  this._fbPut(`/rooms/${this.roomCode}/Direct_${item.uid}.json`, this._stampMsg(reply));
                });
              }
            }
          } else {
            const authRes = await fetch(`${this.fbUrl}/rooms/${this.roomCode}/Direct_${this.myId}.json`);
            if (authRes.ok) {
              const directMsg = await authRes.json();
              if (directMsg && !this.connected) {
                this._handleIncomingOnGuest(directMsg);
              }
            }
            const stateRes = await fetch(`${this.fbUrl}/rooms/${this.roomCode}/state.json`);
            if (stateRes.ok) {
              const st = await stateRes.json();
              if (st && st.updatedAt && st.updatedAt > lastSeenTs) {
                lastSeenTs = st.updatedAt;
                this._handleIncomingOnGuest(st);
              }
            }
          }
        } catch (e) {}
      }, 900);
    }

    _emitStatus(mode, text) {
      if (this.callbacks.onStatus) this.callbacks.onStatus({ mode, text });
    }

    _emitError(message) {
      if (this.callbacks.onError) this.callbacks.onError(message);
    }

    disconnect() {
      this._clearJoinTimers();
      if (this.fbPollTimer) {
        clearInterval(this.fbPollTimer);
        this.fbPollTimer = null;
      }
      if (this.mqttClient) {
        try {
          this.mqttClient.end(true);
        } catch (e) {}
        this.mqttClient = null;
      }
      if (this.bc) {
        try {
          this.bc.close();
        } catch (e) {}
        this.bc = null;
      }
      if (this.hostConn) {
        try {
          this.hostConn.close();
        } catch (e) {}
        this.hostConn = null;
      }
      for (const [, conn] of this.guestConns.entries()) {
        try {
          conn.close();
        } catch (e) {}
      }
      this.guestConns.clear();
      if (this.peer) {
        try {
          this.peer.destroy();
        } catch (e) {}
        this.peer = null;
      }
      this.connected = false;
    }
  }

  global.RoomNetwork = RoomNetwork;
})(typeof window !== "undefined" ? window : globalThis);

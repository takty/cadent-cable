# Cadent Cable Protocol

This document describes the Cadent Cable wire protocol.

Cadent Cable is a room-based WebSocket relay system. A client creates or joins a room, then exchanges JSON text messages through a WebSocket connection.

## Terms

### Room

A room is an isolated communication group identified by `roomId`.

A room is not closed simply because a receiver disconnects. A room may be closed when it becomes empty and the server's empty-room timeout expires, or when the server explicitly closes it for another reason.

### Member

A member is one active WebSocket connection in a room.

Each active member has:

* `memberId`
* `displayName`
* `role`

A reconnecting client is treated as a new WebSocket connection and receives a new `memberId`.

### Room mode

`roomMode` controls how events are delivered.

| Value       | Meaning                                            |
| ----------- | -------------------------------------------------- |
| `broadcast` | Events are sent to all active members in the room. |
| `remote`    | Controller events are sent only to the receiver.   |

### Member role

| Value        | Meaning                                   |
| ------------ | ----------------------------------------- |
| `member`     | A normal member in `broadcast` mode.      |
| `receiver`   | The owner-side receiver in `remote` mode. |
| `controller` | A controller client in `remote` mode.     |

In `broadcast` mode, all active clients are `member`.

In `remote` mode:

* A client that joins with the correct `ownerToken` becomes `receiver`.
* Other clients become `controller`.
* At most one receiver is active at a time.
* If a new receiver connects while another receiver is active, the previous receiver is closed.
* If the receiver disconnects, the room remains open while other active members remain.
* The receiver can reconnect later by using the same `ownerToken`.
* Controllers remain connected while no receiver is active.

### Join request status

| Value      | Meaning                                             |
| ---------- | --------------------------------------------------- |
| `created`  | A join request has been created.                    |
| `updated`  | A join request has received an additional approval. |
| `expired`  | A join request has expired.                         |
| `canceled` | A pending client disconnected before approval.      |

## Time values

All time values are numbers in milliseconds.

The protocol uses monotonic clocks, not Unix timestamps. Time values are meaningful only for comparing elapsed time or ordering events within the same clock domain.

Client-side time values are based on the client's monotonic clock.

| Field            | Meaning                                                   |
| ---------------- | --------------------------------------------------------- |
| `clientTime`     | Client monotonic time when application data was produced. |
| `clientSendTime` | Client monotonic time when a sync request was sent.       |
| `clientRecvTime` | Client monotonic time when a sync response was received.  |

Server-side time values are based on the server's monotonic clock.

| Field            | Meaning                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `serverTime`     | Server monotonic time when a server event was generated.                   |
| `serverRecvTime` | Server monotonic time when a sync request was received.                    |
| `serverSendTime` | Server monotonic time when a sync response was sent.                       |
| `receivedAt`     | Server monotonic time when a `data` message was received.                  |
| `eventTime`      | Estimated server-side event time for a `data` message.                    |
| `expiresAt`      | Server monotonic time when a pending join request expires.                 |
| `now`            | Server monotonic time returned by the health endpoint.                     |

For a `data` message, the server computes `eventTime` from `clientTime` and the current estimated `offsetToServerTime` for that connection. If no usable client time estimate is available, the server uses `receivedAt` as `eventTime`.

`offsetToServerTime` is the estimated value to add to a client-side monotonic time to convert it into the server's monotonic time domain.

## HTTP endpoints

The server identifies endpoints by the last path segment. Therefore the server can be mounted under an arbitrary base path.

For example, these can all be valid depending on deployment:

* `/rooms`
* `/api/cc/rooms`
* `/cadent-cable/rooms`

### `GET /health`

Returns the current server status.

Response body:

```json
{
  "ok": true,
  "rooms": 1,
  "now": 12345.67
}
```

| Field   | Type     | Meaning                                |
| ------- | -------- | -------------------------------------- |
| `ok`    | `true`   | Health check result.                   |
| `rooms` | `number` | Number of active rooms.                |
| `now`   | `number` | Server monotonic time in milliseconds. |

### `POST /rooms`

Creates a room.

Request body:

```json
{
  "roomId": null,
  "roomMode": "broadcast",
  "approvalRatio": 0
}
```

| Field           | Type                        | Required | Meaning                                                                    |
| --------------- | --------------------------- | -------- | -------------------------------------------------------------------------- |
| `roomId`        | `string` or `null`          | No       | Requested room ID. If omitted, empty, or `null`, the server generates one. |
| `roomMode`      | `"broadcast"` or `"remote"` | No       | Room mode. Defaults to `broadcast`.                                        |
| `approvalRatio` | `number`                    | No       | Approval ratio from `0` to `1`. `0` means no approval is required.         |

Successful response body:

```json
{
  "ok": true,
  "roomId": "ABC234",
  "roomMode": "broadcast",
  "approvalRatio": 0,
  "ownerToken": "owner_xxxxxxxxxxxx",
  "joinUrl": "/ws?roomId=ABC234&displayName=...",
  "ownerJoinUrl": "/ws?roomId=ABC234&displayName=...&ownerToken=owner_xxxxxxxxxxxx"
}
```

| Field           | Type       | Meaning                                        |
| --------------- | ---------- | ---------------------------------------------- |
| `ok`            | `true`     | Room creation succeeded.                       |
| `roomId`        | `string`   | Room ID.                                       |
| `roomMode`      | `RoomMode` | Room mode.                                     |
| `approvalRatio` | `number`   | Normalized approval ratio.                     |
| `ownerToken`    | `string`   | Token used by the owner-side client.           |
| `joinUrl`       | `string`   | Relative WebSocket URL for ordinary clients.   |
| `ownerJoinUrl`  | `string`   | Relative WebSocket URL including `ownerToken`. |

Error response body:

```json
{
  "ok": false,
  "error": "room_id_already_exists"
}
```

Common HTTP error codes:

| Code                       | Meaning                                              |
| -------------------------- | ---------------------------------------------------- |
| `id_too_short`             | The requested room ID is too short.                  |
| `id_too_long`              | The requested room ID is too long.                   |
| `id_has_invalid_character` | The requested room ID contains an invalid character. |
| `room_id_already_exists`   | The requested room ID is already in use.             |
| `not_found`                | The route was not found.                             |

## WebSocket endpoint

### `GET /ws?roomId=...&displayName=...&ownerToken=...`

Joins a room by WebSocket.

Query parameters:

| Parameter     | Required | Meaning                                |
| ------------- | -------- | -------------------------------------- |
| `roomId`      | Yes      | Room ID.                               |
| `displayName` | Yes      | Display name for this connection.      |
| `ownerToken`  | No       | Owner token returned by `POST /rooms`. |

The server accepts only text messages containing JSON objects.

Binary WebSocket messages are rejected with an `error` event.

### Local client wrapper events

`open` and `close` are local events emitted by the TypeScript client wrapper.

They are not JSON messages sent over the WebSocket connection.

Other implementations, such as Unity C# or Python clients, may represent these as local callback events rather than protocol message types.

## Client to server messages

### `data`

Sends application payload data.

```json
{
  "type": "data",
  "clientTime": 12345.67,
  "payload": {
    "button": true
  }
}
```

| Field        | Type           | Required | Meaning                                |
| ------------ | -------------- | -------- | -------------------------------------- |
| `type`       | `"data"`       | Yes      | Message type.                          |
| `clientTime` | `number`       | No       | Client monotonic time in milliseconds. If omitted, the server uses its receive time as the event time. |
| `payload`    | any JSON value | Yes      | Application-defined payload.           |

If `clientTime` is present and a valid clock offset is available, the server estimates `eventTime` in server monotonic time from `clientTime`; otherwise, `receivedAt` is used as `eventTime`.

In `broadcast` mode, data from active members is relayed to the room.

In `remote` mode:

* Controllers can send data.
* The receiver cannot send data.
* If no receiver is active, controller data is ignored.

### `approve`

Approves a pending join request.

```json
{
  "type": "approve",
  "requestId": "req_xxxxxxxxxxxx"
}
```

| Field       | Type        | Required | Meaning          |
| ----------- | ----------- | -------- | ---------------- |
| `type`      | `"approve"` | Yes      | Message type.    |
| `requestId` | `string`    | Yes      | Join request ID. |

In `broadcast` mode, active members can approve join requests.

In `remote` mode, only the receiver can approve join requests.

### `syncRequest`

Starts a clock synchronization round trip.

```json
{
  "type": "syncRequest",
  "clientSendTime": 12345.67
}
```

| Field            | Type            | Required | Meaning                                          |
| ---------------- | --------------- | -------- | ------------------------------------------------ |
| `type`           | `"syncRequest"` | Yes      | Message type.                                    |
| `clientSendTime` | `number`        | Yes      | Client monotonic time when the request was sent. |

### `syncReport`

Completes a clock synchronization round trip.

```json
{
  "type": "syncReport",
  "clientSendTime": 12345.67,
  "serverRecvTime": 12350.00,
  "serverSendTime": 12350.10,
  "clientRecvTime": 12355.20
}
```

| Field            | Type           | Required | Meaning                                                 |
| ---------------- | -------------- | -------- | ------------------------------------------------------- |
| `type`           | `"syncReport"` | Yes      | Message type.                                           |
| `clientSendTime` | `number`       | Yes      | Original client send time.                              |
| `serverRecvTime` | `number`       | Yes      | Server receive time from `syncResponse`.                |
| `serverSendTime` | `number`       | Yes      | Server send time from `syncResponse`.                   |
| `clientRecvTime` | `number`       | Yes      | Client monotonic time when `syncResponse` was received. |

The server computes:

```text
rtt = (clientRecvTime - clientSendTime) - (serverSendTime - serverRecvTime)
offsetToServerTime = ((serverRecvTime - clientSendTime) + (serverSendTime - clientRecvTime)) / 2
```

The server keeps the best result with the lowest RTT for each connection.

## Server to client messages

### `joined`

Sent when a connection becomes active.

```json
{
  "type": "joined",
  "serverTime": 12345.67,
  "roomId": "ABC234",
  "roomMode": "broadcast",
  "memberId": "m_xxxxxxxxxxxx",
  "displayName": "Alice",
  "role": "member",
  "members": [
    {
      "memberId": "m_xxxxxxxxxxxx",
      "displayName": "Alice",
      "role": "member"
    }
  ]
}
```

In `remote` mode, a controller receives an empty `members` array in `joined`.

In `remote` mode, a receiver receives the current active member list in `joined`. This list includes the receiver itself and any controllers that are already connected. Therefore, when a receiver reconnects, it receives the current controller state at the time it becomes active.

### `pending`

Sent to a joining client when approval is required.

```json
{
  "type": "pending",
  "serverTime": 12345.67,
  "roomId": "ABC234",
  "requestId": "req_xxxxxxxxxxxx",
  "displayName": "Bob",
  "requiredApprovals": 1,
  "timeoutMs": 30000
}
```

### `joinRequest`

Sent to approvers when a join request is created, updated, expired, or canceled.

```json
{
  "type": "joinRequest",
  "status": "created",
  "serverTime": 12345.67,
  "roomId": "ABC234",
  "requestId": "req_xxxxxxxxxxxx",
  "displayName": "Bob",
  "requiredApprovals": 1,
  "approvals": 0,
  "expiresAt": 42345.67
}
```

| Field    | Type                | Meaning                                          |
| -------- | ------------------- | ------------------------------------------------ |
| `status` | `JoinRequestStatus` | Current status of the join request.              |
| `reason` | `string` or omitted | Reason when the request expired or was rejected. |

### `joinRejected`

Sent to a pending client when its join request is rejected.

```json
{
  "type": "joinRejected",
  "serverTime": 12345.67,
  "roomId": "ABC234",
  "requestId": "req_xxxxxxxxxxxx",
  "reason": "timeout"
}
```

After this message, the server closes the WebSocket connection.

A remote room is not closed simply because the receiver disconnects. If controllers remain connected, the room remains open. If all members leave, the room may be closed after the server's empty-room timeout.

### `memberJoined`

Sent when a member joins.

```json
{
  "type": "memberJoined",
  "serverTime": 12345.67,
  "roomId": "ABC234",
  "memberId": "m_xxxxxxxxxxxx",
  "displayName": "Alice",
  "members": [
    {
      "memberId": "m_xxxxxxxxxxxx",
      "displayName": "Alice",
      "role": "member"
    }
  ]
}
```

In `remote` mode, controller join events are sent only to the receiver.

### `memberLeft`

Sent when a member leaves.

```json
{
  "type": "memberLeft",
  "serverTime": 12345.67,
  "roomId": "ABC234",
  "memberId": "m_xxxxxxxxxxxx",
  "displayName": "Alice"
}
```

In `remote` mode, controller leave events are sent only to the receiver.

### `tick`

Sent when queued data messages are flushed.

```json
{
  "type": "tick",
  "serverTime": 12345.67,
  "roomId": "ABC234",
  "tickSeq": 1,
  "messages": [
    {
      "from": "m_xxxxxxxxxxxx",
      "displayName": "Alice",
      "clientTime": 12340.00,
      "eventTime": 12345.00,
      "receivedAt": 12345.20,
      "payload": {
        "button": true
      }
    }
  ]
}
```

Each item in `messages` has the following fields:

| Field         | Type           | Meaning                                                     |
| ------------- | -------------- | ----------------------------------------------------------- |
| `from`        | `string`       | Member ID of the sender.                                    |
| `displayName` | `string`       | Display name of the sender.                                 |
| `clientTime`  | `number`       | Original client-side time if provided by the sender.        |
| `eventTime`   | `number`       | Estimated server-side event time used for ordering.         |
| `receivedAt`  | `number`       | Server-side receive time used as a tie-breaker for ordering.|
| `payload`     | any JSON value | Application-defined payload.                                |

Queued messages are sorted by `eventTime`, then by `receivedAt`.

In `broadcast` mode, `tick` is sent to all active members.

In `remote` mode, `tick` is sent only to the receiver.

### `heartbeat`

Sent periodically when there is no queued data.

```json
{
  "type": "heartbeat",
  "serverTime": 12345.67,
  "roomId": "ABC234",
  "tickSeq": 1,
  "members": [
    {
      "memberId": "m_xxxxxxxxxxxx",
      "displayName": "Alice",
      "role": "member"
    }
  ]
}
```

In `remote` mode, `heartbeat` is sent only to the receiver.

### `roomClosed`

Sent when a room is closed.

```json
{
  "type": "roomClosed",
  "serverTime": 12345.67,
  "roomId": "ABC234",
  "reason": "empty_timeout"
}
```

After this message, the server closes active WebSocket connections in the room.

### `syncResponse`

Sent in response to `syncRequest`.

```json
{
  "type": "syncResponse",
  "clientSendTime": 12345.67,
  "serverRecvTime": 12350.00,
  "serverSendTime": 12350.10
}
```

### `syncStatus`

Sent in response to `syncReport`.

```json
{
  "type": "syncStatus",
  "serverTime": 12345.67,
  "rtt": 9.43,
  "offsetToServerTime": 4.57
}
```

| Field                | Type     | Meaning                                                                       |
| -------------------- | -------- | ----------------------------------------------------------------------------- |
| `rtt`                | `number` | Estimated round-trip time in milliseconds.                                    |
| `offsetToServerTime` | `number` | Estimated value to add to client monotonic time to get server monotonic time. |

### `error`

Sent when the server rejects a message or detects an error.

```json
{
  "type": "error",
  "code": "invalid_json",
  "message": "Message must be valid JSON."
}
```

Common error codes:

| Code                        | Meaning                                             |
| --------------------------- | --------------------------------------------------- |
| `room_not_found`            | The requested room does not exist.                  |
| `unsupported_message`       | The server received a non-text WebSocket message.   |
| `invalid_json`              | The message was not valid JSON.                     |
| `invalid_message`           | The message was not a JSON object.                  |
| `unknown_type`              | The message type is not supported.                  |
| `not_active`                | The connection is not active yet.                   |
| `not_receiver`              | The operation is allowed only for the receiver.     |
| `join_request_not_found`    | The join request was not found.                     |
| `receiver_cannot_send_data` | A receiver attempted to send data in `remote` mode. |
| `invalid_sync_request`      | `syncRequest` had an invalid timestamp.             |
| `invalid_sync_report`       | `syncReport` had invalid timestamp fields.          |
| `invalid_rtt`               | The computed RTT was negative.                      |
| `receiver_replaced`         | Another receiver connected to the same remote room. |

## Data delivery rules

### Broadcast mode

* Active members can send `data`.
* Data is queued by the server.
* Queued data is sent as `tick` to all active members.
* `memberJoined`, `memberLeft`, `joinRequest`, `tick`, `heartbeat`, and `roomClosed` are sent to all active members.

### Remote mode

* The receiver joins by using `ownerToken`.
* Controllers join without `ownerToken`.
* Controllers can send `data`.
* The receiver cannot send `data`.
* Controller data is sent as `tick` only to the receiver.
* If no receiver is active, controller data is discarded.
* Controller data sent while no receiver is active is not buffered.
* When a receiver reconnects, only data sent after the receiver becomes active is delivered.
* Controller connections remain active while no receiver is active.
* Controller join and leave events are sent only to the receiver.
* Controller join and leave events that occur while no receiver is active are not buffered.
* A receiver that reconnects receives the current active member list in `joined`.
* Approval requests are sent only to the receiver.
* If a new receiver connects while another receiver is active, the previous receiver is closed with `receiver_replaced`.
* The room is not closed simply because the receiver disconnects.
* If all members leave, the room may be closed after the server's empty-room timeout.

## Client implementation notes

A client implementation should:

1. Use `POST /rooms` to create a room if needed.
2. Build a WebSocket URL using `roomId`, `displayName`, and optionally `ownerToken`.
3. Send and receive only JSON text messages.
4. Store `memberId` after receiving `joined`.
5. Periodically send `syncRequest` if event ordering based on client time is needed.
6. Reply to `syncResponse` with `syncReport`.
7. Store `rtt` and `offsetToServerTime` after receiving `syncStatus`.
8. Send application input as `data` with arbitrary JSON `payload`.

## Type summary

```ts
type RoomMode = 'broadcast' | 'remote';
type MemberRole = 'member' | 'receiver' | 'controller';
type JoinRequestStatus = 'created' | 'updated' | 'expired' | 'canceled';
```

```ts
type MemberInfo = {
  memberId: string;
  displayName: string;
  role: MemberRole;
};
```

```ts
type QueuedMessage<TPayload = unknown> = {
  from: string;
  displayName: string;
  clientTime?: number;
  eventTime: number;
  receivedAt: number;
  payload: TPayload;
};
```

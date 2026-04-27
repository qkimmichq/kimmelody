import { WebSocketServer } from 'ws';

export class WsBroadcaster {
  constructor(server) {
    this.wss = new WebSocketServer({ server });
    this.clients = new Set();
    this.onUserCommand = null;

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.subscriptions = new Set();

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          switch (msg.type) {
            case 'user:command':
              this.onUserCommand?.(msg.text);
              break;
            case 'subscribe':
              if (msg.event) ws.subscriptions.add(msg.event);
              break;
            case 'unsubscribe':
              if (msg.event) ws.subscriptions.delete(msg.event);
              break;
            case 'ping':
              ws.send(JSON.stringify({ event: 'pong', timestamp: Date.now() }));
              break;
          }
        } catch {
          // 忽略无效消息
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });

      // 发送欢迎消息
      ws.send(JSON.stringify({
        event: 'connected',
        payload: { message: 'Kimmelody 电台已连接' },
        timestamp: Date.now(),
      }));
    });
  }

  broadcast(event, payload) {
    const message = JSON.stringify({ event, payload, timestamp: Date.now() });
    let sent = 0;

    for (const client of this.clients) {
      if (client.readyState === 1) {
        // 如果客户端设置了事件过滤，只推送订阅的事件
        if (client.subscriptions.size > 0 && !client.subscriptions.has(event)) continue;
        client.send(message);
        sent++;
      }
    }

    return sent;
  }

  // 获取连接数
  get connectionCount() {
    return this.clients.size;
  }
}

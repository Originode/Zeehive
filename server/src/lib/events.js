// Tiny in-process event bus for SSE fan-out. Queenzee/API emit; /api/stream subscribes.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(200);

// type: 'zee' | 'xell' | 'container' | 'task' | 'tick'
export function broadcast(type, payload) {
  bus.emit('event', { type, payload, ts: Date.now() });
}

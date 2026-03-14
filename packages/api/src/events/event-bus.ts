import { EventEmitter } from "node:events";
import type { AppEvent } from "./event-types";

export class AppEventBus {
  private readonly emitter = new EventEmitter();

  emit(event: AppEvent) {
    this.emitter.emit(event.type, event);
  }

  on<T extends AppEvent["type"]>(type: T, listener: (event: Extract<AppEvent, { type: T }>) => void) {
    this.emitter.on(type, listener as (event: AppEvent) => void);
  }

  off<T extends AppEvent["type"]>(type: T, listener: (event: Extract<AppEvent, { type: T }>) => void) {
    this.emitter.off(type, listener as (event: AppEvent) => void);
  }
}

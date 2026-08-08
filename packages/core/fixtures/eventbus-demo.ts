// fixture: 最小 EventBus 场景——验证 tree-sitter query 能识别 emit/on 调用
class EventBus {
  private handlers: Map<string, Function[]> = new Map();
  emit(event: string, data?: unknown): void {
    const hs = this.handlers.get(event) ?? [];
    for (const h of hs) h(data);
  }
  on(event: string, handler: Function): void {
    const hs = this.handlers.get(event) ?? [];
    hs.push(handler);
    this.handlers.set(event, hs);
  }
}

// 生产者
export const bus = new EventBus();
bus.emit("order.created", { id: 1 });

// 消费者
bus.on("order.created", (data) => console.log("order", data));

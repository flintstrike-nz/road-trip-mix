// Touch- and mouse-friendly drag-to-reorder for a vertical list, using pointer
// events on a drag handle. The list's items need `data-id`; the handle is any
// descendant matching `.handle`. The caller re-renders after `onMove`.

export function makeSortable(
  list: HTMLElement,
  onMove: (id: string, toIndex: number) => void,
  onDragState?: (dragging: boolean) => void
): void {
  list.addEventListener("pointerdown", (ev) => {
    const handle = (ev.target as HTMLElement).closest(".handle");
    const item = handle?.closest<HTMLElement>("[data-id]");
    if (!handle || !item || !list.contains(item)) return;
    ev.preventDefault();

    const items = Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-id]"));
    const from = items.indexOf(item);
    const rects = items.map((el) => el.getBoundingClientRect());
    const height = rects[from].height;
    const startY = ev.clientY;
    let to = from;

    handle.setPointerCapture(ev.pointerId);
    item.classList.add("dragging");
    onDragState?.(true);

    const move = (e: PointerEvent) => {
      const dy = e.clientY - startY;
      item.style.transform = `translateY(${dy}px)`;
      const center = rects[from].top + dy + height / 2;
      to = 0;
      rects.forEach((r, i) => {
        if (i !== from && r.top + r.height / 2 < center) to++;
      });
      items.forEach((el, i) => {
        if (i === from) return;
        const shift = from < to && i > from && i <= to ? -height : from > to && i >= to && i < from ? height : 0;
        el.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    };

    const end = () => {
      handle.removeEventListener("pointermove", move as EventListener);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      items.forEach((el) => {
        el.style.transform = "";
        el.classList.remove("dragging");
      });
      onDragState?.(false);
      if (to !== from) onMove(item.dataset.id!, to);
    };

    handle.addEventListener("pointermove", move as EventListener);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
}

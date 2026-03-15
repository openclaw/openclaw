/**
 * Mouse-based drag scrolling for the horizontal nav bar on narrow viewports.
 * Touch devices already get native drag scrolling; this covers desktop mice
 * when the scrollbar is hidden via CSS.
 */
export function setupNavDragScroll(host: HTMLElement): () => void {
  const nav = host.querySelector<HTMLElement>(".nav");
  if (!nav) {
    return () => {};
  }

  const mql = window.matchMedia("(max-width: 1100px)");

  let active = false;
  let startX = 0;
  let startScrollLeft = 0;
  let didDrag = false;
  let suppressNextClick = false;
  let bound = false;

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) {
      return;
    }
    active = true;
    didDrag = false;
    startX = e.pageX;
    startScrollLeft = nav!.scrollLeft;
  }

  function onMouseMove(e: MouseEvent) {
    if (!active) {
      return;
    }
    if (e.buttons === 0) {
      // Mouse button was released outside the window; reset state.
      onMouseUp();
      return;
    }
    const dx = e.pageX - startX;
    if (!didDrag && Math.abs(dx) < 5) {
      return;
    }
    if (!didDrag) {
      didDrag = true;
      nav!.style.cursor = "grabbing";
      nav!.style.userSelect = "none";
    }
    e.preventDefault();
    nav!.scrollLeft = startScrollLeft - dx;
  }

  function onMouseUp() {
    if (!active) {
      return;
    }
    active = false;
    nav!.style.cursor = "grab";
    nav!.style.userSelect = "";
    if (didDrag) {
      suppressNextClick = true;
    }
  }

  function onClickCapture(e: MouseEvent) {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function bind() {
    if (bound) {
      return;
    }
    bound = true;
    nav!.style.cursor = "grab";
    nav!.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    nav!.addEventListener("click", onClickCapture, true);
  }

  function unbind() {
    if (!bound) {
      return;
    }
    bound = false;
    active = false;
    didDrag = false;
    suppressNextClick = false;
    nav!.style.cursor = "";
    nav!.style.userSelect = "";
    nav!.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    nav!.removeEventListener("click", onClickCapture, true);
  }

  function onMediaChange() {
    if (mql.matches) {
      bind();
    } else {
      unbind();
    }
  }

  // Initial check
  onMediaChange();
  mql.addEventListener("change", onMediaChange);

  return () => {
    unbind();
    mql.removeEventListener("change", onMediaChange);
  };
}

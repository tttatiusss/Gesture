(function () {
  const EXT_URL = chrome.runtime.getURL("camera.html");

  // ---------- Painel flutuante ----------
  const panel = document.createElement("div");
  panel.id = "gestura-panel";
  panel.innerHTML = `
    <div id="gestura-header">
      <span><span class="dot" id="gestura-dot"></span>Gestura Chess</span>
      <button id="gestura-collapse" title="Minimizar">_</button>
    </div>
    <div id="gestura-body">
      <iframe id="gestura-iframe" src="${EXT_URL}" allow="camera"></iframe>
      <button id="gestura-toggle">iniciar controle por gestos</button>
      <div id="gestura-hint">
        Pinca (polegar + indicador) para segurar uma peca, solte a pinca para largar.
        Mantenha a mao dentro da area central da camera.
      </div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  const cursorEl = document.createElement("div");
  cursorEl.id = "gestura-virtual-cursor";
  document.documentElement.appendChild(cursorEl);

  // ---------- Arrastar o painel ----------
  (function makeDraggable() {
    const header = panel.querySelector("#gestura-header");
    let dragging = false, offX = 0, offY = 0;
    header.addEventListener("mousedown", (e) => {
      if (e.target.id === "gestura-collapse") return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = e.clientX - offX + "px";
      panel.style.top = e.clientY - offY + "px";
      panel.style.right = "auto";
    });
    window.addEventListener("mouseup", () => (dragging = false));
  })();

  panel.querySelector("#gestura-collapse").addEventListener("click", () => {
    panel.classList.toggle("collapsed");
  });

  // ---------- Toggle iniciar/parar ----------
  const iframe = panel.querySelector("#gestura-iframe");
  const toggleBtn = panel.querySelector("#gestura-toggle");
  const dot = panel.querySelector("#gestura-dot");
  let active = false;

  toggleBtn.addEventListener("click", () => {
    active = !active;
    iframe.contentWindow.postMessage({ cmd: active ? "start" : "stop" }, "*");
    toggleBtn.textContent = active ? "parar controle" : "iniciar controle por gestos";
    toggleBtn.classList.toggle("stop", active);
    cursorEl.style.display = active ? "block" : "none";
    if (!active) dot.className = "dot";
  });

  // ---------- Estado do gesto / drag virtual ----------
  let wasPinching = false;
  let dragTarget = null;

  function pointerOpts(x, y, extra) {
    return Object.assign(
      {
        view: window,
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      },
      extra
    );
  }

  function mouseOpts(x, y, extra) {
    return Object.assign(
      {
        view: window,
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
      },
      extra
    );
  }

  function fireAt(el, x, y, phase) {
    if (!el) return;
    if (phase === "down") {
      el.dispatchEvent(new PointerEvent("pointerover", pointerOpts(x, y)));
      el.dispatchEvent(new PointerEvent("pointerdown", pointerOpts(x, y, { buttons: 1, button: 0 })));
      el.dispatchEvent(new MouseEvent("mouseover", mouseOpts(x, y)));
      el.dispatchEvent(new MouseEvent("mousedown", mouseOpts(x, y, { buttons: 1, button: 0 })));
    } else if (phase === "move") {
      el.dispatchEvent(new PointerEvent("pointermove", pointerOpts(x, y, { buttons: 1 })));
      el.dispatchEvent(new MouseEvent("mousemove", mouseOpts(x, y, { buttons: 1 })));
    } else if (phase === "up") {
      el.dispatchEvent(new PointerEvent("pointerup", pointerOpts(x, y, { buttons: 0, button: 0 })));
      el.dispatchEvent(new MouseEvent("mouseup", mouseOpts(x, y, { buttons: 0, button: 0 })));
      el.dispatchEvent(new MouseEvent("click", mouseOpts(x, y, { buttons: 0, button: 0 })));
    }
  }

  function handleCursor(nx, ny, pinching) {
    const x = nx * window.innerWidth;
    const y = ny * window.innerHeight;

    cursorEl.style.left = x + "px";
    cursorEl.style.top = y + "px";
    cursorEl.classList.toggle("pinching", pinching);

    if (pinching && !wasPinching) {
      // inicio da pinca -> "mousedown" no elemento embaixo do cursor
      dragTarget = document.elementFromPoint(x, y);
      fireAt(dragTarget, x, y, "down");
      dot.className = "dot pinch";
    } else if (pinching && wasPinching) {
      // pinca mantida -> arrastando
      fireAt(dragTarget, x, y, "move");
    } else if (!pinching && wasPinching) {
      // soltou a pinca -> "mouseup" + "click" no elemento atual
      const dropTarget = document.elementFromPoint(x, y) || dragTarget;
      fireAt(dropTarget, x, y, "up");
      dragTarget = null;
      dot.className = "dot on";
    }

    wasPinching = pinching;
  }

  window.addEventListener("message", (ev) => {
    if (!ev.data || ev.data.source !== "gestura-cam") return;
    const data = ev.data;

    if (data.type === "ready") {
      dot.className = "dot on";
    } else if (data.type === "error") {
      dot.className = "dot";
      toggleBtn.textContent = "erro: " + data.message;
    } else if (data.type === "cursor") {
      if (!active) return;
      if (!data.present) {
        dot.className = "dot on";
        return;
      }
      handleCursor(data.x, data.y, data.pinching);
    }
  });
})();

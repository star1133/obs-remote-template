// Add to Home Screen. Chrome, Edge and Samsung Internet offer their own install prompt (beforeinstallprompt), which a
// button in Settings opens. iPhone/iPad have no prompt, so Settings shows the Share-menu steps instead. Once the app
// runs from the home screen the card hides itself.
export function createInstall({ $, h, toast, store }) {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS says "Mac"
  const touch = navigator.maxTouchPoints > 0;
  // A Quick Tunnel link changes every time OBS starts, so an icon for it would stop working the next day.
  const tempLink = /\.trycloudflare\.com$/.test(location.hostname);
  let prompt = null;

  const standalone = () => matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches || navigator.standalone === true;

  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); prompt = e; render(); });
  addEventListener("appinstalled", () => { prompt = null; render(); toast("Added to your home screen", "info"); });

  function steps() {
    const share = h("b", {}, "Share");
    return ios
      ? h("ol", { class: "steps" },
          h("li", {}, "Tap ", share, " (the square with an arrow, top right on iPad, bottom on iPhone)."),
          h("li", {}, "Choose ", h("b", {}, "Add to Home Screen"), ", then ", h("b", {}, "Add"), "."),
          h("li", {}, "Open OBS Remote from the new icon. If it asks for a code, make one in OBS → Tools → OBS Remote."))
      : h("p", { class: "hint" }, "Open your browser's menu (⋮) and choose ", h("b", {}, "Install app"), " or ", h("b", {}, "Add to Home screen"), ".");
  }

  function render() {
    const box = $("#homeBox");
    if (!box) return;
    box.hidden = standalone();
    if (box.hidden) return;
    const btn = $("#btnHome");
    btn.hidden = !prompt;
    $("#homeHow").replaceChildren(prompt ? "" : steps());
    $("#homeWarn").hidden = !tempLink;
  }

  async function install() {
    if (!prompt) return;
    const p = prompt;
    prompt = null;
    await p.prompt();
    const { outcome } = await p.userChoice.catch(() => ({}));
    if (outcome !== "accepted") toast("Not added. You can do it later from Settings.", "info");
    render();
  }

  return {
    bind() { $("#btnHome")?.addEventListener("click", install); render(); },
    render,
    standalone,
    /** After the first pairing on a phone or tablet: one gentle pointer to the home screen, never again after that. */
    nudge() {
      if (standalone() || tempLink || !touch || store.get("obsr.homeTip")) return;
      store.set("obsr.homeTip", 1);
      setTimeout(() => toast("Tip: add OBS Remote to your Home Screen to open it like an app. Settings → Home screen.", "info", 7000), 2500);
    },
  };
}

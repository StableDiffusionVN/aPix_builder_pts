const ICONS = {
  check: "✓",
  chevronUp: "▲",
  chevronDown: "▼",
  refresh: "↻",
  reveal: "○",
  conceal: "●"
};

export function setButtonIcon(button, name, label) {
  if (!button) return;
  button.textContent = ICONS[name] || "";
  if (label) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}

export function syncSecretToggleButton(button, input, labels = {}) {
  if (!button || !input) return;
  const hidden = input.type === "password";
  const showLabel = labels.show || "Show";
  const hideLabel = labels.hide || "Hide";
  setButtonIcon(button, hidden ? "reveal" : "conceal", hidden ? showLabel : hideLabel);
}

export function setSettingsToggleIcon(button, collapsed) {
  setButtonIcon(
    button,
    collapsed ? "chevronDown" : "chevronUp",
    collapsed ? "Show settings" : "Hide settings"
  );
}

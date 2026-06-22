// Shared HTML escaper — used by both browser modules (app.js, storyboard.js) so
// there is one implementation, not two that drift. Escapes the five characters
// that matter in element-text AND attribute-value contexts (the quote and
// apostrophe matter once a value is placed inside an attribute).
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

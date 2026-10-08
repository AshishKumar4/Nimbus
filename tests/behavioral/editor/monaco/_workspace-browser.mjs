function workspaceInPage(surface) {
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' };
  };
  const pane = (id) => box(document.getElementById(id));
  const button = (id) => {
    const element = document.getElementById(id);
    return { ...box(element), active: element.classList.contains('active'), pressed: element.getAttribute('aria-pressed') };
  };
  const state = {
    classes: [...document.getElementById('mainPanel').classList],
    agentSurface: document.getElementById('leftStack').classList.contains('agent-surface'),
    tree: pane('treePanel'), stack: pane('leftStack'), editor: pane('editorPanel'), agent: pane('agentPanel'),
    terminal: box(document.querySelector('.panel-terminal')), preview: pane('previewPanel'),
    editorButton: button('btnEditor'), agentButton: button('btnAgent'),
    tab: document.getElementById('editorTab').textContent,
    editorReady: !!window.__nimbusMonacoEditor && !!document.querySelector('.monaco-editor .view-lines'),
    agentReady: document.querySelector('#agentPanel .agent-title')?.textContent === 'Nimbus Agent'
      && !!document.getElementById('agentStatus')?.textContent && document.getElementById('agentStatus').textContent !== 'Checking...',
    connected: document.getElementById('statusDot').classList.contains('connected'),
  };
  if (!surface) return state;
  const selected = surface === 'agent' ? state.agentButton : state.editorButton;
  return state.connected && state.classes.includes('editor') && state.tree.visible && state.terminal.visible && state.preview.visible
    && selected.active && selected.pressed === 'true'
    && (surface === 'agent'
      ? state.agentSurface && state.agent.visible && !state.editor.visible && state.agentReady
      : !state.agentSurface && state.editor.visible && !state.agent.visible && state.editorReady);
}

export function workspaceState(page) {
  return page.evaluate(workspaceInPage);
}

export function waitForWorkspace(page, surface) {
  return page.waitForFunction(workspaceInPage, { timeout: 60_000 }, surface);
}

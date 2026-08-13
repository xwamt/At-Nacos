/**
 * The page behind `NacosInstanceFormPanel`. It reads fields, posts them, and
 * renders what comes back -- every decision about what is valid and what gets
 * stored belongs to the extension host, which is the only side that can be
 * tested and the only side a crafted message cannot reach around.
 */

type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

interface FormStrings {
  submit: string;
  saving: string;
  testConnection: string;
  testing: string;
  unknownError: string;
}

/**
 * Only reached if the data block is missing or unparseable, which means the
 * extension side is broken -- but a form that still works in English beats a
 * blank panel.
 */
const FALLBACK_STRINGS: FormStrings = {
  submit: 'Save Instance',
  saving: 'Saving...',
  testConnection: 'Test Connection',
  testing: 'Testing connection...',
  unknownError: 'Something went wrong.'
};

const vscode = acquireVsCodeApi();
const strings = readStrings();
const form = document.querySelector<HTMLFormElement>('#instance-form');
const authMode = document.querySelector<HTMLSelectElement>('#authMode');
const formError = document.querySelector<HTMLElement>('#form-error');
const testStatus = document.querySelector<HTMLElement>('#testStatus');
const testConnectionButton = document.querySelector<HTMLButtonElement>('#testConnectionButton');
const submitButton = document.querySelector<HTMLButtonElement>('#submitButton');
const submitLabel = document.querySelector<HTMLElement>('#submitLabel');

function readStrings(): FormStrings {
  const block = document.getElementById('atNacosStrings');
  if (!block?.textContent) {
    return FALLBACK_STRINGS;
  }
  try {
    return { ...FALLBACK_STRINGS, ...(JSON.parse(block.textContent) as Partial<FormStrings>) };
  } catch {
    return FALLBACK_STRINGS;
  }
}

function field(name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
  const element = form?.elements.namedItem(name);
  return element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
    ? element
    : null;
}

function readValue(name: string): string {
  return field(name)?.value ?? '';
}

function isChecked(name: string): boolean {
  const element = field(name);
  return element instanceof HTMLInputElement && element.checked;
}

/** Every field, every time: the extension host parses this and rejects a partial one. */
function payloadFromForm(): Record<string, unknown> {
  return {
    label: readValue('label'),
    serverUrl: readValue('serverUrl'),
    consoleUrl: readValue('consoleUrl'),
    authMode: readValue('authMode'),
    username: readValue('username'),
    password: readValue('password'),
    customHeaders: readValue('customHeaders'),
    readOnly: isChecked('readOnly'),
    allowBackgroundAccess: isChecked('allowBackgroundAccess')
  };
}

function setError(message: string): void {
  if (formError) {
    formError.textContent = message;
  }
}

function setTestStatus(message: string, state?: 'success' | 'error'): void {
  if (!testStatus) {
    return;
  }
  testStatus.textContent = message;
  testStatus.classList.toggle('is-success', state === 'success');
  testStatus.classList.toggle('is-error', state === 'error');
}

function setSaving(isSaving: boolean): void {
  submitButton?.toggleAttribute('disabled', isSaving);
  if (submitLabel) {
    submitLabel.textContent = isSaving ? strings.saving : strings.submit;
  }
}

function setTesting(isTesting: boolean): void {
  testConnectionButton?.toggleAttribute('disabled', isTesting);
  if (testConnectionButton) {
    testConnectionButton.textContent = isTesting ? strings.testing : strings.testConnection;
  }
}

/**
 * Which credential fields are shown is a class on the form; the rules live in
 * the stylesheet. The modes come from the options the extension rendered, so
 * there is no second list here to fall out of step with the first.
 */
function applyAuthMode(mode: string): void {
  if (!form || !authMode) {
    return;
  }
  for (const option of Array.from(authMode.options)) {
    form.classList.toggle(`auth-mode-${option.value}`, option.value === mode);
  }
}

authMode?.addEventListener('change', () => {
  applyAuthMode(authMode.value);
});

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  setError('');
  setSaving(true);
  vscode.postMessage({ type: 'submit', payload: payloadFromForm() });
});

testConnectionButton?.addEventListener('click', () => {
  setError('');
  setTestStatus(strings.testing);
  setTesting(true);
  vscode.postMessage({ type: 'testConnection', payload: payloadFromForm() });
});

window.addEventListener('message', (event: MessageEvent<{ type?: string; payload?: unknown }>) => {
  const message = event.data;
  if (message.type === 'error') {
    // A save that failed left the panel open, so the button has to come back.
    setSaving(false);
    setError(typeof message.payload === 'string' ? message.payload : strings.unknownError);
    return;
  }
  if (message.type === 'connectionTestResult') {
    setTesting(false);
    const payload = (message.payload ?? {}) as { ok?: boolean; message?: string };
    setTestStatus(payload.message ?? strings.unknownError, payload.ok ? 'success' : 'error');
  }
});

// Keeps these names off the global type space. Without it TypeScript treats a
// file with no imports as a script, and the next Webview to declare a `form`
// or a `strings` collides with this one.
export {};

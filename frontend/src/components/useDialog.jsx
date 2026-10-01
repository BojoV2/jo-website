import { useCallback, useEffect, useRef, useState } from 'react';

// In-app replacement for window.confirm / window.prompt / window.alert.
// Same calling shape, but awaited:
//   if (!(await dialog.confirm('Delete this?', { danger: true }))) return;
//   const note = await dialog.prompt('Optional note');   // null when cancelled
// Render {dialog.element} once in the component.
export default function useDialog() {
  const [state, setState] = useState(null);
  const resolver = useRef(null);
  const inputRef = useRef(null);
  const confirmRef = useRef(null);

  const open = useCallback((options) => new Promise((resolve) => {
    // a second dialog opened while one is showing cancels the first
    if (resolver.current) resolver.current(options.kind === 'confirm' ? false : null);
    resolver.current = resolve;
    setState({ ...options, value: options.defaultValue || '' });
  }), []);

  const finish = useCallback((result) => {
    const resolve = resolver.current;
    resolver.current = null;
    setState(null);
    if (resolve) resolve(result);
  }, []);

  const cancelValue = state?.kind === 'confirm' ? false : state?.kind === 'alert' ? undefined : null;

  useEffect(() => {
    if (!state) return undefined;
    const t = setTimeout(() => (inputRef.current || confirmRef.current)?.focus(), 30);
    const onKey = (e) => { if (e.key === 'Escape') finish(cancelValue); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [state, finish, cancelValue]);

  const confirm = useCallback((message, opts = {}) => open({ kind: 'confirm', message, ...opts }), [open]);
  const prompt = useCallback((message, opts = {}) => open({ kind: 'prompt', message, ...opts }), [open]);
  const alert = useCallback((message, opts = {}) => open({ kind: 'alert', message, ...opts }), [open]);

  let element = null;
  if (state) {
    const trimmed = String(state.value || '').trim();
    const blocked = state.kind === 'prompt' && (
      (state.required && !trimmed) ||
      (state.expect !== undefined && trimmed !== state.expect)
    );
    const submit = (e) => {
      e.preventDefault();
      if (blocked) return;
      if (state.kind === 'confirm') finish(true);
      else if (state.kind === 'alert') finish(undefined);
      else finish(state.value);
    };
    element = (
      <div className="modal-backdrop jo-dialog-backdrop" role="presentation" onClick={() => finish(cancelValue)}>
        <form
          className="jo-dialog"
          role={state.kind === 'alert' ? 'alertdialog' : 'dialog'}
          aria-modal="true"
          aria-labelledby="jo-dialog-title"
          onClick={(e) => e.stopPropagation()}
          onSubmit={submit}
        >
          <h3 id="jo-dialog-title">{state.title || (state.kind === 'confirm' ? 'Are you sure?' : state.kind === 'alert' ? 'Details' : 'Enter a value')}</h3>
          <p className="jo-dialog-message">{state.message}</p>
          {state.kind === 'prompt' && (
            <>
              <input
                ref={inputRef}
                type={state.type || 'text'}
                value={state.value}
                placeholder={state.placeholder || ''}
                autoComplete={state.type === 'password' ? 'new-password' : 'off'}
                onChange={(e) => setState({ ...state, value: e.target.value })}
              />
              {state.hint && <p className="jo-dialog-hint">{state.hint}</p>}
            </>
          )}
          <div className="jo-dialog-actions">
            {state.kind !== 'alert' && (
              <button type="button" className="jo-dialog-cancel" onClick={() => finish(cancelValue)}>
                {state.cancelLabel || 'Cancel'}
              </button>
            )}
            <button
              ref={confirmRef}
              type="submit"
              className={state.danger ? 'jo-dialog-ok jo-dialog-danger' : 'jo-dialog-ok'}
              disabled={blocked}
            >
              {state.confirmLabel || (state.kind === 'alert' ? 'Close' : 'OK')}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return { confirm, prompt, alert, element };
}

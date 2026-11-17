import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Bot } from '@shared/types';
import { api } from '../lib/api';
import { displayName, useStore } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { useDictation } from '../voice/dictation';

const MAX_H = 200;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const drafts = new Map<string, string>();

interface PendingImage { name: string; mimeType: string; dataUrl: string; size: number }

function readImage(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name || 'image'}.`));
    reader.onload = () => typeof reader.result === 'string'
      ? resolve({ name: file.name || 'pasted-image.png', mimeType: file.type, dataUrl: reader.result, size: file.size })
      : reject(new Error('Could not read image.'));
    reader.readAsDataURL(file);
  });
}

export function Composer({ bot, running }: { bot: Bot; running: boolean }) {
  const [text, setText] = useState(() => drafts.get(bot.id) ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const voiceEnabled = useStore((s) => s.features.voice);
  const setModal = useStore((s) => s.setModal);

  // Per-bot drafts.
  useEffect(() => { setText(drafts.get(bot.id) ?? ''); setImages([]); setError(null); ref.current?.focus(); }, [bot.id]);
  useEffect(() => { drafts.set(bot.id, text); }, [bot.id, text]);

  // Auto-grow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden';
  }, [text]);

  // ⌘I focuses the prompt.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const send = async () => {
    const t = text.trim();
    if ((!t && images.length === 0) || sending) return;
    setSending(true); setError(null);
    try {
      await api.send(bot.id, t, images.map(({ name, mimeType, dataUrl }) => ({ name, mimeType, dataUrl })));
      setText('');
      setImages([]);
      drafts.delete(bot.id);
    } catch (e) {
      setError((e as Error).message || 'Message failed to send');
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const stop = () => api.interrupt(bot.id).catch((e) => setError(e.message));
  const fresh = () => api.fresh(bot.id).catch((e) => setError(e.message));

  // Dictation: insert the transcript at the cursor.
  const insertText = (t: string) => {
    const el = ref.current;
    setText((cur) => {
      const start = el && document.activeElement === el ? el.selectionStart : cur.length;
      const end = el && document.activeElement === el ? el.selectionEnd : cur.length;
      const before = cur.slice(0, start);
      const after = cur.slice(end);
      const pre = before && !/\s$/.test(before) ? ' ' : '';
      const post = after && !/^\s/.test(after) ? ' ' : '';
      requestAnimationFrame(() => { if (el) { const pos = before.length + pre.length + t.length; el.focus(); el.setSelectionRange(pos, pos); } });
      return before + pre + t + post + after;
    });
  };
  const dictation = useDictation(insertText, setError, bot.voiceLanguage);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);

  const addImages = async (files: FileList | File[]) => {
    const incoming = Array.from(files).filter((file) => /^image\/(png|jpeg|webp|gif)$/.test(file.type));
    if (!incoming.length) return;
    setError(null);
    const chosen = incoming.slice(0, Math.max(0, MAX_IMAGES - images.length));
    if (chosen.length < incoming.length) setError(`Attach up to ${MAX_IMAGES} images per message.`);
    try {
      const loaded = await Promise.all(chosen.map(readImage));
      const total = [...images, ...loaded].reduce((sum, image) => sum + image.size, 0);
      if (total > MAX_IMAGE_BYTES) throw new Error('Images must total 10 MB or less.');
      setImages((current) => [...current, ...loaded].slice(0, MAX_IMAGES));
      ref.current?.focus();
    } catch (e) { setError((e as Error).message); }
  };

  const hasText = text.trim().length > 0;
  const hasContent = hasText || images.length > 0;
  const multiline = text.includes('\n') || (ref.current?.scrollHeight ?? 0) > 30;

  return (
    <div className={`composer-area${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => { if (Array.from(e.dataTransfer.items).some((item) => item.type.startsWith('image/'))) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => { setDragging(false); const files = Array.from(e.dataTransfer.files).filter((file) => file.type.startsWith('image/')); if (files.length) { e.preventDefault(); void addImages(files); } }}
    >
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
      {images.length > 0 && <div className="composer__attachments" aria-label="Attached images">
        {images.map((image, index) => <div className="composer__attachment" key={`${image.name}-${index}`}>
          <img src={image.dataUrl} alt={image.name} />
          <button type="button" onClick={() => setImages((current) => current.filter((_, i) => i !== index))} aria-label={`Remove ${image.name}`}>×</button>
        </div>)}
      </div>}
      <div className={`composer${multiline ? ' is-multiline' : ''}`}>
        <div className="composer__left">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { if (e.target.files) void addImages(e.target.files); e.target.value = ''; }} />
          <span className="composer__plus-anchor">
            <button type="button" className="composer__btn" onClick={() => setMenu(!menu)} aria-label="More actions" aria-expanded={menu}>
              <Icon name="composer_plus" opacity={0.56} />
            </button>
            {menu && (
              <Menu
                placement="above"
                onClose={() => setMenu(false)}
                items={[
                  { label: 'Attach images…', onSelect: () => fileRef.current?.click() },
                  { label: 'New conversation', onSelect: fresh },
                  { label: 'Connect apps', onSelect: () => setModal('apps') },
                ]}
              />
            )}
          </span>
          <textarea
            ref={ref}
            className="composer__input"
            rows={1}
            value={text}
            placeholder={`Message ${displayName(bot)}`}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.items).filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file);
              if (files.length) { e.preventDefault(); void addImages(files); }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
            aria-label={`Message ${bot.name}`}
          />
        </div>
        <div className="composer__right">
          {voiceEnabled && <button
            type="button"
            className={`composer__btn${dictation.state === 'recording' ? ' is-recording' : dictation.state === 'transcribing' ? ' is-transcribing' : ''}`}
            aria-label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
            aria-pressed={dictation.state === 'recording'}
            title={dictation.state === 'recording' ? 'Release or click to stop · Esc cancels' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Hold to dictate, or click to start'}
            disabled={dictation.state === 'transcribing'}
            onPointerDown={dictation.onPointerDown}
            onPointerUp={dictation.onPointerUp}
            onKeyDown={dictation.onKeyDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Icon name="mic" opacity={0.56} />
          </button>}
          {inCall && !hasText ? (
            <button type="button" className="composer__cta is-in-call" onClick={endCall} aria-label="End voice call" title="End voice call">
              <Icon name="voice_a" size={16} />
            </button>
          ) : running && !hasText ? (
            <button type="button" className="composer__cta" onClick={stop} aria-label="Stop" title="Stop">
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="composer__cta"
              onClick={hasContent ? send : voiceEnabled ? () => startCall(bot.id) : undefined}
              disabled={sending || (!hasContent && !voiceEnabled)}
              aria-label={hasContent ? 'Send' : `Start voice chat with ${bot.name}`}
              title={hasContent ? 'Send (Enter)' : voiceEnabled ? 'Start voice chat' : 'Type a message'}
            >
              <Icon name={hasContent ? 'arrow_up' : 'voice_a'} size={16} />
            </button>
          )}
        </div>
      </div>
      {dragging && <div className="composer__drop-hint">Drop screenshots to attach</div>}
    </div>
  );
}

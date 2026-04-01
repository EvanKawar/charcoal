import { useState, useEffect, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { readDir, readTextFile, writeTextFile, mkdir, remove, rename } from '@tauri-apps/plugin-fs';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize } from '@tauri-apps/api/dpi';
import Editor from './components/Editor';
import './App.css';

// ─── Tree types ───────────────────────────────────────────────────────────────

type FileNode   = { type: 'file';   name: string; path: string };
type FolderNode = { type: 'folder'; name: string; path: string; children: TreeNode[] | null; expand?: boolean };
type TreeNode   = FileNode | FolderNode;

// ─── Theme ────────────────────────────────────────────────────────────────────

interface Theme {
  editorBg: string; text: string; bold: string;
  italic: string; blockquote: string; strikethrough: string;
  h1: string; h2: string; h3: string;
  math: string;
  fontSize: number;
  fontFamily: string;
  contentWidth: 'centered' | 'wide' | 'full';
  showWordCount: boolean;
  borderless: boolean;
}

interface CustomThemeEntry { id: string; name: string; theme: Theme; }

// ─── Font options ─────────────────────────────────────────────────────────────

const FONT_OPTIONS = [
  { value: 'georgia',         label: 'Georgia'         },
  { value: 'inter',           label: 'Inter'           },
  { value: 'lora',            label: 'Lora'            },
  { value: 'merriweather',    label: 'Merriweather'    },
  { value: 'source-serif-4',  label: 'Source Serif 4'  },
  { value: 'jetbrains-mono',  label: 'JetBrains Mono'  },
  { value: 'system',          label: 'System Sans'     },
] as const;

const FONT_CSS: Record<string, string> = {
  georgia:          `"Georgia", "Times New Roman", serif`,
  inter:            `"Inter", system-ui, sans-serif`,
  lora:             `"Lora", Georgia, serif`,
  merriweather:     `"Merriweather", Georgia, serif`,
  'source-serif-4': `"Source Serif 4", Georgia, serif`,
  'jetbrains-mono': `"JetBrains Mono", "Fira Code", "Cascadia Code", monospace`,
  system:           `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
};

const CONTENT_WIDTH_CONFIG = {
  centered: { maxWidth: '740px',  padV: '60px', padH: '48px' },
  wide:     { maxWidth: '1100px', padV: '48px', padH: '48px' },
  full:     { maxWidth: 'none',   padV: '32px', padH: '24px' },
} as const;

// ─── Keyboard shortcuts reference ─────────────────────────────────────────────

const SHORTCUTS = [
  { action: 'Export to PDF',       keys: 'Ctrl+Shift+E' },
  { action: 'Toggle word count',   keys: 'Ctrl+Shift+W' },
  { action: 'Toggle hide titlebar', keys: 'Ctrl+Shift+L' },
];

// ─── Welcome note content ─────────────────────────────────────────────────────

const WELCOME_CONTENT = `# Welcome to charcoal

charcoal is a minimalist markdown note-taking app. This file is your quick\
 reference — delete it whenever you're ready.

---

## Your Vault

Everything you write lives in a **vault** — a plain folder on your computer.\
 charcoal never uploads your notes anywhere. Only you can access them.

You can organise your vault with **folders and subfolders**:

- Hover over any folder in the sidebar to reveal options to add notes,\
 create subfolders, rename, or delete.
- **Drag and drop** a note onto a folder to move it.
- Deleting a folder gives you the option to move its contents to the vault\
 root first, so nothing is lost by accident.
- The sidebar shows your full folder tree — click a folder to expand it.

---

## Headings

# Heading 1
## Heading 2
### Heading 3

---

## Text Formatting

**Bold** — surround with \`**double asterisks**\`

*Italic* — surround with \`*single asterisks*\`

~~Strikethrough~~ — surround with \`~~double tildes~~\`

\`Inline code\` — surround with backticks

---

## Blockquotes

> This is a blockquote.
> Use it for callouts, citations, or anything you want to stand out.

---

## Lists

Unordered:

- Item one
- Item two
  - Nested item
- Item three

Ordered:

1. First step
2. Second step
3. Third step

---

## Links & Images

[Link text](https://example.com)

Paste an image directly into a note with **Ctrl+V** — charcoal saves it to\
 your vault's \`assets/\` folder automatically.

---

## Code Blocks

\`\`\`python
def greet(name):
    return f"Hello, {name}!"
\`\`\`

\`\`\`js
const add = (a, b) => a + b;
\`\`\`

---

## Math (KaTeX)

Surround your equation with \`$\` signs for inline math.

$E = mc^2$

$a^2 + b^2 = c^2$

$\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$

---

## Horizontal Rule

Three dashes \`---\` on their own line create a divider.

---

## Keyboard Shortcuts

- **Ctrl+Shift+E** — Export note to PDF
- **Ctrl+Shift+W** — Toggle word & character count
- **Ctrl+Shift+L** — Toggle titlebar visibility

---

*Happy writing.*
`;

// ─── Default theme ────────────────────────────────────────────────────────────

const DEFAULT_THEME: Theme = {
  editorBg: '#1e1e2e', text: '#cdd6f4', bold: '#ffffff',
  italic: '#f5c2e7', blockquote: '#cba6f7', strikethrough: '#6c7086',
  h1: '#cba6f7', h2: '#89b4fa', h3: '#89dceb',
  math: '#a6e3a1',
  fontSize: 16,
  fontFamily: 'georgia',
  contentWidth: 'centered',
  showWordCount: false,
  borderless: false,
};

// ─── Built-in themes ──────────────────────────────────────────────────────────

interface BuiltinThemeEntry { id: string; name: string; theme: Theme; }

const BUILTIN_THEMES: BuiltinThemeEntry[] = [
  { id: 'catppuccin-mocha', name: 'Catppuccin', theme: { ...DEFAULT_THEME } },
  {
    id: 'nordic', name: 'Nordic',
    theme: { editorBg: '#2e3440', text: '#eceff4', bold: '#e5e9f0',
      italic: '#b48ead', blockquote: '#88c0d0', strikethrough: '#4c566a',
      h1: '#81a1c1', h2: '#88c0d0', h3: '#8fbcbb',
      math: '#a3be8c', fontSize: 16, fontFamily: 'merriweather', contentWidth: 'centered',
      showWordCount: false, borderless: false },
  },
  {
    id: 'sweet-dark', name: 'Sweet Dark',
    theme: { editorBg: '#1e1c31', text: '#c0b9f0', bold: '#ff8b92',
      italic: '#c39ac9', blockquote: '#ffd280', strikethrough: '#685e88',
      h1: '#ff8b92', h2: '#f1ac5e', h3: '#69e1d0',
      math: '#96e072', fontSize: 16, fontFamily: 'lora', contentWidth: 'centered',
      showWordCount: false, borderless: false },
  },
  {
    id: 'solarized-dark', name: 'Solarized',
    theme: { editorBg: '#002b36', text: '#839496', bold: '#fdf6e3',
      italic: '#6c71c4', blockquote: '#268bd2', strikethrough: '#586e75',
      h1: '#cb4b16', h2: '#268bd2', h3: '#2aa198',
      math: '#859900', fontSize: 16, fontFamily: 'merriweather', contentWidth: 'centered',
      showWordCount: false, borderless: false },
  },
  {
    id: 'gruvbox', name: 'Gruvbox',
    theme: { editorBg: '#282828', text: '#ebdbb2', bold: '#fbf1c7',
      italic: '#d3869b', blockquote: '#8ec07c', strikethrough: '#7c6f64',
      h1: '#fb4934', h2: '#fabd2f', h3: '#8ec07c',
      math: '#b8bb26', fontSize: 16, fontFamily: 'merriweather', contentWidth: 'centered',
      showWordCount: false, borderless: false },
  },
  {
    id: 'prof-gnome', name: 'Prof-GNOME',
    theme: { editorBg: '#1c1c1c', text: '#d8d8d8', bold: '#ffffff',
      italic: '#b294bb', blockquote: '#8abeb7', strikethrough: '#555555',
      h1: '#cc6666', h2: '#81a2be', h3: '#b5bd68',
      math: '#f0c674', fontSize: 16, fontFamily: 'inter', contentWidth: 'centered',
      showWordCount: false, borderless: false },
  },
  {
    id: 'whitesur', name: 'WhiteSur',
    theme: { editorBg: '#242424', text: '#f5f5f5', bold: '#ffffff',
      italic: '#6096fa', blockquote: '#636366', strikethrough: '#545458',
      h1: '#6096fa', h2: '#30d158', h3: '#ffd60a',
      math: '#30d158', fontSize: 16, fontFamily: 'inter', contentWidth: 'centered',
      showWordCount: false, borderless: false },
  },
  {
    id: 'redmond97', name: 'Redmond97',
    theme: { editorBg: '#0a0a5a', text: '#c0c0c0', bold: '#ffffff',
      italic: '#00cccc', blockquote: '#008080', strikethrough: '#666688',
      h1: '#ffffff', h2: '#00cccc', h3: '#00cc66',
      math: '#ffff00', fontSize: 16, fontFamily: 'jetbrains-mono', contentWidth: 'centered',
      showWordCount: false, borderless: false },
  },
];

// ─── Theme persistence ────────────────────────────────────────────────────────

function loadTheme(): Theme {
  try {
    const s = localStorage.getItem('charcoal_theme');
    if (s) return { ...DEFAULT_THEME, ...JSON.parse(s) };
  } catch {}
  return DEFAULT_THEME;
}

function applyTheme(t: Theme) {
  const r = document.documentElement;
  r.style.setProperty('--ch-font-size',     `${t.fontSize}px`);
  r.style.setProperty('--ch-editor-bg',     t.editorBg);
  r.style.setProperty('--ch-text',          t.text);
  r.style.setProperty('--ch-bold',          t.bold);
  r.style.setProperty('--ch-italic',        t.italic);
  r.style.setProperty('--ch-blockquote',    t.blockquote);
  r.style.setProperty('--ch-strikethrough', t.strikethrough);
  r.style.setProperty('--ch-h1',            t.h1);
  r.style.setProperty('--ch-h2',            t.h2);
  r.style.setProperty('--ch-h3',            t.h3);
  r.style.setProperty('--ch-math',          t.math);
  r.style.setProperty('--ch-font-family',   FONT_CSS[t.fontFamily] ?? FONT_CSS.georgia);
  const wc = CONTENT_WIDTH_CONFIG[t.contentWidth] ?? CONTENT_WIDTH_CONFIG.centered;
  r.style.setProperty('--ch-content-max-width', wc.maxWidth);
  r.style.setProperty('--ch-content-pad-v',     wc.padV);
  r.style.setProperty('--ch-content-pad-h',     wc.padH);
}

function loadCustomThemes(): CustomThemeEntry[] {
  try {
    const s = localStorage.getItem('charcoal_custom_themes');
    if (s) return JSON.parse(s);
  } catch {}
  return [];
}

function persistCustomThemes(themes: CustomThemeEntry[]) {
  localStorage.setItem('charcoal_custom_themes', JSON.stringify(themes));
}

// ─── Vault helpers ────────────────────────────────────────────────────────────

async function collectAllFiles(dirPath: string): Promise<string[]> {
  const entries = await readDir(dirPath);
  const files: string[] = [];
  for (const e of entries) {
    if (!e.name) continue;
    const fullPath = `${dirPath}/${e.name}`;
    if (e.isDirectory) files.push(...(await collectAllFiles(fullPath)));
    else files.push(fullPath);
  }
  return files;
}

async function moveContentsToRoot(folderPath: string, rootPath: string): Promise<void> {
  const rootEntries = await readDir(rootPath);
  const existing = new Set(rootEntries.map((e) => e.name ?? '').filter(Boolean));
  const allFiles = await collectAllFiles(folderPath);
  for (const filePath of allFiles) {
    const parts = filePath.split('/');
    const filename = parts[parts.length - 1];
    let destName = filename;
    if (existing.has(destName)) {
      const parentFolder = parts[parts.length - 2];
      const base = filename.replace(/\.md$/, '');
      destName = `${parentFolder}-${base}.md`;
      let n = 2;
      while (existing.has(destName)) destName = `${parentFolder}-${base}-${n++}.md`;
    }
    existing.add(destName);
    const content = await readTextFile(filePath);
    await writeTextFile(`${rootPath}/${destName}`, content);
  }
  await remove(folderPath, { recursive: true });
}

// ─── Tree helpers ─────────────────────────────────────────────────────────────

async function loadEntries(dirPath: string): Promise<TreeNode[]> {
  const entries = await readDir(dirPath);
  return entries
    .filter((e) => e.name && !e.name.startsWith('.') && (e.isDirectory || e.name.endsWith('.md')))
    .map((e): TreeNode =>
      e.isDirectory
        ? { type: 'folder', name: e.name!, path: `${dirPath}/${e.name}`, children: null }
        : { type: 'file',   name: e.name!, path: `${dirPath}/${e.name}` }
    )
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

async function loadEntriesRecursive(dirPath: string): Promise<TreeNode[]> {
  const entries = await loadEntries(dirPath);
  return Promise.all(
    entries.map(async (entry): Promise<TreeNode> => {
      if (entry.type !== 'folder') return entry;
      try {
        return { ...entry, children: await loadEntriesRecursive(entry.path) };
      } catch {
        return { ...entry, children: [] };
      }
    })
  );
}

function removeNode(nodes: TreeNode[], targetPath: string): TreeNode[] {
  return nodes
    .filter((n) => n.path !== targetPath)
    .map((n) =>
      n.type === 'folder' && n.children
        ? { ...n, children: removeNode(n.children, targetPath) }
        : n
    );
}

function insertNode(nodes: TreeNode[], parentPath: string | null, newNode: TreeNode): TreeNode[] {
  const sorted = (arr: TreeNode[]) =>
    [...arr].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  if (parentPath === null) return sorted([...nodes, newNode]);
  return nodes.map((n) => {
    if (n.path === parentPath && n.type === 'folder')
      return { ...n, children: sorted([...(n.children ?? []), newNode]), expand: true };
    if (n.type === 'folder' && n.children)
      return { ...n, children: insertNode(n.children, parentPath, newNode) };
    return n;
  });
}

function renameNodeInTree(nodes: TreeNode[], oldPath: string, newPath: string, newName: string): TreeNode[] {
  return nodes.map((n) => {
    if (n.path === oldPath) return { ...n, path: newPath, name: newName };
    if (n.type === 'folder' && n.children)
      return { ...n, children: renameNodeInTree(n.children, oldPath, newPath, newName) };
    return n;
  });
}

// ─── Viewer mode ──────────────────────────────────────────────────────────────

const _params     = new URLSearchParams(window.location.search);
const isViewer    = _params.get('viewer') === '1';
const viewerNote  = _params.get('note');
const viewerVault = _params.get('vault');

applyTheme(loadTheme());

// ─── ViewerApp ────────────────────────────────────────────────────────────────

function ViewerApp() {
  const [theme, setTheme] = useState<Theme>(loadTheme);

  useEffect(() => {
    if (loadTheme().borderless) {
      getCurrentWindow().setDecorations(false).catch(console.error);
    }
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'charcoal_theme') {
        const t = loadTheme();
        applyTheme(t);
        setTheme(t);
        getCurrentWindow().setDecorations(!t.borderless).catch(console.error);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      switch (e.key.toUpperCase()) {
        case 'E':
          e.preventDefault();
          window.print();
          break;
        case 'W':
          e.preventDefault();
          setTheme((t) => {
            const updated = { ...t, showWordCount: !t.showWordCount };
            applyTheme(updated);
            localStorage.setItem('charcoal_theme', JSON.stringify(updated));
            return updated;
          });
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="app-shell">
      <div className="viewer-mode">
        <Editor
          filePath={decodeURIComponent(viewerNote!)}
          notesPath={decodeURIComponent(viewerVault!)}
          showWordCount={theme.showWordCount}
        />
      </div>
    </div>
  );
}

// ─── ColorRow ─────────────────────────────────────────────────────────────────

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [hex, setHex] = useState(value);
  useEffect(() => { setHex(value); }, [value]);
  const commit = (v: string) => { setHex(v); if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v); };
  return (
    <div className="color-row">
      <span className="color-label">{label}</span>
      <input type="color" className="color-swatch" value={value}
        onChange={(e) => { setHex(e.target.value); onChange(e.target.value); }} />
      <input type="text" className="color-hex-input" value={hex} maxLength={7} spellCheck={false}
        onChange={(e) => commit(e.target.value)} onBlur={() => setHex(value)} />
    </div>
  );
}

// ─── SliderRow ────────────────────────────────────────────────────────────────

function SliderRow({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  unit?: string; onChange: (v: number) => void;
}) {
  return (
    <div className="slider-row">
      <span className="color-label">{label}</span>
      <input type="range" className="slider-input" min={min} max={max} step={step}
        value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-value">{value}{unit}</span>
    </div>
  );
}

// ─── ToggleRow ────────────────────────────────────────────────────────────────

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="toggle-row">
      <span className="color-label">{label}</span>
      <button className={`toggle-btn${value ? ' on' : ''}`} onClick={() => onChange(!value)}
        role="switch" aria-checked={value}>
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

// ─── WelcomeScreen ────────────────────────────────────────────────────────────

function WelcomeScreen({
  onOpen,
  onCreate,
}: {
  onOpen: () => void;
  onCreate: (parentDir: string, name: string) => Promise<void>;
}) {
  const [vaultName, setVaultName] = useState('My Notes');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    const name = vaultName.trim();
    if (!name) return;
    const parent = await open({ directory: true, title: 'Choose where to create your vault' });
    if (!parent || typeof parent !== 'string') return;
    setCreating(true);
    try {
      await onCreate(parent, name);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="app-welcome">
      <h1>charcoal</h1>
      <p className="welcome-subtitle">A minimalist note-taking app</p>
      <div className="welcome-cards">
        <div className="welcome-card">
          <div className="welcome-card-title">New vault</div>
          <div className="welcome-card-desc">Create a fresh notes folder</div>
          <input
            className="welcome-input"
            value={vaultName}
            onChange={(e) => setVaultName(e.target.value)}
            placeholder="Vault name"
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
            spellCheck={false}
          />
          <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>
            {creating ? 'Creating…' : 'Choose location →'}
          </button>
        </div>
        <div className="welcome-card-sep">or</div>
        <div className="welcome-card">
          <div className="welcome-card-title">Open vault</div>
          <div className="welcome-card-desc">Open an existing notes folder</div>
          <button className="btn btn-ghost welcome-open-btn" onClick={onOpen}>
            Browse folders →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SettingsPanel ────────────────────────────────────────────────────────────

function SettingsPanel({
  theme, customThemes, onChange, onReset, onApplyPreset, onSaveCustomTheme,
  onDeleteCustomTheme, onToggleBorderless,
}: {
  theme: Theme;
  customThemes: CustomThemeEntry[];
  onChange: (key: keyof Theme, value: string | number | boolean) => void;
  onReset: () => void;
  onApplyPreset: (t: Theme) => void;
  onSaveCustomTheme: (name: string) => void;
  onDeleteCustomTheme: (id: string) => void;
  onToggleBorderless: () => void;
}) {
  const [saveInput, setSaveInput] = useState('');
  const [showSaveForm, setShowSaveForm] = useState(false);

  const row = (label: string, key: keyof Theme) => (
    <ColorRow key={key} label={label} value={theme[key] as string} onChange={(v) => onChange(key, v)} />
  );

  const commitSave = () => {
    const name = saveInput.trim();
    if (!name) return;
    onSaveCustomTheme(name);
    setSaveInput('');
    setShowSaveForm(false);
  };

  return (
    <div className="settings-panel">

      {/* ── Themes ────────────────────────────────────────────────────── */}
      <span className="settings-section-label">Themes</span>
      <div className="theme-preset-grid">
        {BUILTIN_THEMES.map((p) => (
          <button key={p.id} className="theme-preset-btn" onClick={() => onApplyPreset(p.theme)}>
            <span className="theme-dot" style={{ background: p.theme.h1 }} />
            <span className="theme-preset-name">{p.name}</span>
          </button>
        ))}
        {customThemes.map((ct) => (
          <div key={ct.id} className="theme-preset-btn custom-preset-row">
            <button className="custom-preset-apply" onClick={() => onApplyPreset(ct.theme)}>
              <span className="theme-dot" style={{ background: ct.theme.h1 }} />
              <span className="theme-preset-name">{ct.name}</span>
            </button>
            <button className="theme-delete-btn" title="Delete theme"
              onClick={() => onDeleteCustomTheme(ct.id)}>×</button>
          </div>
        ))}
      </div>
      {showSaveForm ? (
        <div className="save-theme-form">
          <input className="save-theme-input" placeholder="Theme name…" value={saveInput} autoFocus
            onChange={(e) => setSaveInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitSave(); if (e.key === 'Escape') { setSaveInput(''); setShowSaveForm(false); } }} />
          <button className="btn btn-ghost save-form-btn" onClick={commitSave}>Save</button>
          <button className="btn btn-ghost save-form-btn" onClick={() => { setSaveInput(''); setShowSaveForm(false); }}>✕</button>
        </div>
      ) : (
        <button className="btn btn-ghost settings-save-theme" onClick={() => setShowSaveForm(true)}>+ Save as theme</button>
      )}

      {/* ── Typography ────────────────────────────────────────────────── */}
      <span className="settings-section-label">Typography</span>
      <div className="font-row">
        <span className="color-label">Font</span>
        <select className="font-select" value={theme.fontFamily}
          onChange={(e) => onChange('fontFamily', e.target.value)}>
          {FONT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>
      <div className="width-row">
        <span className="color-label" title="Use Full for tiling WMs">Width</span>
        <div className="width-options">
          {(['centered', 'wide', 'full'] as const).map((w) => (
            <button key={w}
              className={`width-btn${theme.contentWidth === w ? ' active' : ''}`}
              title={w === 'centered' ? 'Centered — 740px' : w === 'wide' ? 'Wide — 1100px' : 'Full window width'}
              onClick={() => onChange('contentWidth', w)}>
              {w === 'centered' ? 'Center' : w === 'wide' ? 'Wide' : 'Full'}
            </button>
          ))}
        </div>
      </div>
      <SliderRow label="Font size" value={theme.fontSize} min={10} max={28} step={1} unit="px"
        onChange={(v) => onChange('fontSize', v)} />
      <ToggleRow label="Word count" value={theme.showWordCount}
        onChange={(v) => onChange('showWordCount', v)} />

      {/* ── Window ────────────────────────────────────────────────────── */}
      <span className="settings-section-label">Window</span>
      <ToggleRow label="Hide titlebar" value={theme.borderless} onChange={() => onToggleBorderless()} />

      {/* ── Editor colors ─────────────────────────────────────────────── */}
      <span className="settings-section-label">Editor</span>
      {row('Background',   'editorBg')}
      {row('Body text',    'text')}
      {row('Bold',         'bold')}
      {row('Italic',       'italic')}
      {row('Blockquote',   'blockquote')}
      {row('Strikethrough','strikethrough')}
      <span className="settings-section-label">Headings</span>
      {row('Heading 1', 'h1')}
      {row('Heading 2', 'h2')}
      {row('Heading 3', 'h3')}
      <span className="settings-section-label">Math</span>
      {row('Equations', 'math')}
      <button className="btn btn-ghost settings-reset" onClick={onReset}>Reset to defaults</button>

      {/* ── Keyboard shortcuts ────────────────────────────────────────── */}
      <span className="settings-section-label" style={{ marginTop: 8 }}>Keyboard Shortcuts</span>
      <div className="shortcuts-list">
        {SHORTCUTS.map((s) => (
          <div key={s.action} className="shortcut-row">
            <span className="shortcut-action">{s.action}</span>
            <kbd className="shortcut-key">{s.keys}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Folder delete modal ──────────────────────────────────────────────────────

function FolderDeleteModal({ folderName, onDeleteAll, onMoveToRoot, onCancel }: {
  folderName: string;
  onDeleteAll: () => void;
  onMoveToRoot: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="modal-title">Delete folder</p>
        <p className="modal-body">
          What should happen to <strong>"{folderName}"</strong> and its contents?
        </p>
        <div className="modal-actions">
          <button className="modal-btn modal-btn-danger" onClick={onDeleteAll}>
            Delete folder and all contents
          </button>
          <button className="modal-btn modal-btn-move" onClick={onMoveToRoot}>
            Move all notes to vault root, then delete folder
          </button>
          <button className="modal-btn modal-btn-cancel" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── Titlebar ─────────────────────────────────────────────────────────────────

// ─── TreeItem ─────────────────────────────────────────────────────────────────

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  currentFile: string | null;
  onFileClick:    (path: string) => void;
  onCreateNote:   (parentPath: string) => void;
  onCreateFolder: (parentPath: string) => void;
  onDelete:       (path: string, type: 'file' | 'folder') => void;
  onNewWindow:    (filePath: string) => void;
  onRename:       (path: string, newName: string, type: 'file' | 'folder') => void;
  onMoveFile:     (sourcePath: string, targetPath: string) => void;
}

function TreeItem({
  node, depth, currentFile, onFileClick, onCreateNote, onCreateFolder,
  onDelete, onNewWindow, onRename, onMoveFile,
}: TreeItemProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const expandSignal = node.type === 'folder' ? node.expand : undefined;
  useEffect(() => { if (expandSignal) setIsOpen(true); }, [expandSignal]);

  const indent = depth * 14;
  const childProps = { depth: depth + 1, currentFile, onFileClick, onCreateNote, onCreateFolder, onDelete, onNewWindow, onRename, onMoveFile };

  const startRename = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRenaming(true);
  };

  const commitRename = (newName: string) => {
    setRenaming(false);
    const trimmed = newName.trim();
    const currentBase = node.name.replace(/\.md$/, '');
    if (trimmed && trimmed !== currentBase) onRename(node.path, trimmed, node.type);
  };

  if (node.type === 'file') {
    return (
      <div className="tree-item-row">
        {renaming ? (
          <input
            className="rename-input"
            style={{ marginLeft: `${indent + 28}px` }}
            defaultValue={node.name.replace(/\.md$/, '')}
            autoFocus
            onBlur={(e) => commitRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename((e.target as HTMLInputElement).value);
              if (e.key === 'Escape') setRenaming(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <button
            className={`file-item${currentFile === node.path ? ' active' : ''}`}
            style={{ paddingLeft: `${indent + 28}px` }}
            title={node.name}
            draggable
            onDragStart={(e) => { e.dataTransfer.setData('application/charcoal-path', node.path); e.dataTransfer.effectAllowed = 'move'; }}
            onClick={() => onFileClick(node.path)}
            onDoubleClick={startRename}
          >
            {node.name.replace(/\.md$/, '')}
          </button>
        )}
        {!renaming && (
          <div className="tree-actions">
            <button className="action-btn" title="Open in new window" onClick={() => onNewWindow(node.path)}>↗</button>
            <button className="action-btn" title="Rename" onClick={startRename}>✎</button>
            <button className="action-btn danger" title="Delete note" onClick={() => onDelete(node.path, 'file')}>✕</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="tree-item-row">
        {renaming ? (
          <input
            className="rename-input"
            style={{ marginLeft: `${indent + 8}px` }}
            defaultValue={node.name}
            autoFocus
            onBlur={(e) => commitRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename((e.target as HTMLInputElement).value);
              if (e.key === 'Escape') setRenaming(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <button
            className={`folder-item${dragOver ? ' drag-over' : ''}`}
            style={{ paddingLeft: `${indent + 8}px` }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const src = e.dataTransfer.getData('application/charcoal-path');
              if (src && src !== node.path && !src.startsWith(node.path + '/')) {
                onMoveFile(src, node.path);
              }
            }}
            onClick={() => setIsOpen((o) => !o)}
            onDoubleClick={startRename}
          >
            <span className={`chevron${isOpen ? ' open' : ''}`}>›</span>
            <span className="folder-name">{node.name}</span>
          </button>
        )}
        {!renaming && (
          <div className="tree-actions">
            <button className="action-btn" title="New note in folder"  onClick={() => onCreateNote(node.path)}>+</button>
            <button className="action-btn" title="New subfolder"       onClick={() => onCreateFolder(node.path)}>⊕</button>
            <button className="action-btn" title="Rename"              onClick={startRename}>✎</button>
            <button className="action-btn danger" title="Delete folder" onClick={() => onDelete(node.path, 'folder')}>✕</button>
          </div>
        )}
      </div>
      {isOpen && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeItem key={child.path} node={child} {...childProps} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  if (isViewer && viewerNote && viewerVault) {
    return <ViewerApp />;
  }

  const [notesPath, setNotesPath] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'files' | 'settings'>('files');
  const [loading, setLoading] = useState(false);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [customThemes, setCustomThemes] = useState<CustomThemeEntry[]>(loadCustomThemes);
  const [folderDeleteState, setFolderDeleteState] = useState<{ path: string; name: string } | null>(null);

  // ── Apply theme & persist ────────────────────────────────────────────────
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem('charcoal_theme', JSON.stringify(theme));
  }, [theme]);

  // ── Restore OS decoration state from saved theme on startup ─────────────────
  useEffect(() => {
    if (loadTheme().borderless) {
      getCurrentWindow().setDecorations(false).catch(console.error);
    }
  }, []);

  // ── Theme handlers ───────────────────────────────────────────────────────
  const handleThemeChange = useCallback((key: keyof Theme, value: string | number | boolean) => {
    setTheme((t) => ({ ...t, [key]: value }));
  }, []);

  const handleThemeReset = useCallback(() => setTheme(DEFAULT_THEME), []);
  const handleApplyPreset = useCallback((t: Theme) => setTheme(t), []);

  const handleSaveCustomTheme = useCallback((name: string) => {
    const id = `custom-${Date.now()}`;
    const entry: CustomThemeEntry = { id, name, theme };
    setCustomThemes((prev) => {
      const updated = [...prev, entry];
      persistCustomThemes(updated);
      return updated;
    });
  }, [theme]);

  const handleDeleteCustomTheme = useCallback((id: string) => {
    setCustomThemes((prev) => {
      const updated = prev.filter((t) => t.id !== id);
      persistCustomThemes(updated);
      return updated;
    });
  }, []);

  const handleToggleBorderless = useCallback(async () => {
    const newVal = !theme.borderless;
    setTheme((t) => ({ ...t, borderless: newVal }));
    const win = getCurrentWindow();
    await win.setDecorations(!newVal);
    if (!newVal) {
      // GTK bug: after restoring decorations, webview input region still covers the titlebar.
      // A 1px size nudge forces GTK to recalculate layout and makes the window buttons clickable again.
      const size = await win.innerSize();
      const dpr = window.devicePixelRatio || 1;
      await win.setSize(new LogicalSize(size.width / dpr + 1, size.height / dpr));
      await win.setSize(new LogicalSize(size.width / dpr, size.height / dpr));
    }
  }, [theme.borderless]);

  // ── Global keyboard shortcuts ────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      switch (e.key.toUpperCase()) {
        case 'E':
          e.preventDefault();
          window.print();
          break;
        case 'W':
          e.preventDefault();
          setTheme((t) => ({ ...t, showWordCount: !t.showWordCount }));
          break;
        case 'L':
          e.preventDefault();
          handleToggleBorderless();
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleToggleBorderless]);

  // ── Vault loading ────────────────────────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem('charcoal_notes_path');
    if (saved) setNotesPath(saved);
  }, []);

  useEffect(() => {
    if (!notesPath) return;
    let cancelled = false;
    setLoading(true);
    loadEntriesRecursive(notesPath)
      .then((fresh) => { if (!cancelled) setTree(fresh); })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [notesPath]);

  const selectFolder = async () => {
    const selected = await open({ directory: true });
    if (selected && typeof selected === 'string') {
      setNotesPath(selected);
      localStorage.setItem('charcoal_notes_path', selected);
      setCurrentFile(null);
      setTree([]);
    }
  };

  const createVault = async (parentDir: string, name: string) => {
    const vaultPath = `${parentDir}/${name.trim()}`;
    await mkdir(vaultPath, { recursive: true });
    const welcomePath = `${vaultPath}/welcome.md`;
    await writeTextFile(welcomePath, WELCOME_CONTENT);
    setNotesPath(vaultPath);
    localStorage.setItem('charcoal_notes_path', vaultPath);
    setCurrentFile(welcomePath);
    setTree([]);
  };

  // ── File operations ──────────────────────────────────────────────────────
  const createNote = async () => {
    if (!notesPath) return;
    const name = window.prompt('Note name:');
    if (!name?.trim()) return;
    const filename = name.trim().replace(/\.md$/, '') + '.md';
    const filepath = `${notesPath}/${filename}`;
    try {
      await writeTextFile(filepath, '');
      setTree((t) => insertNode(t, null, { type: 'file', name: filename, path: filepath }));
      setCurrentFile(filepath);
    } catch (err) { console.error(err); }
  };

  const createNoteInFolder = useCallback(async (folderPath: string) => {
    const name = window.prompt('Note name:');
    if (!name?.trim()) return;
    const filename = name.trim().replace(/\.md$/, '') + '.md';
    const filepath = `${folderPath}/${filename}`;
    try {
      await writeTextFile(filepath, '');
      setTree((t) => insertNode(t, folderPath, { type: 'file', name: filename, path: filepath }));
      setCurrentFile(filepath);
    } catch (err) { console.error(err); }
  }, []);

  const createRootFolder = useCallback(async () => {
    if (!notesPath) return;
    const name = window.prompt('Folder name:');
    if (!name?.trim()) return;
    const folderPath = `${notesPath}/${name.trim()}`;
    try {
      await mkdir(folderPath);
      setTree((t) => insertNode(t, null, { type: 'folder', name: name.trim(), path: folderPath, children: [] }));
    } catch (err) { console.error(err); }
  }, [notesPath]);

  const createSubfolder = useCallback(async (parentPath: string) => {
    const name = window.prompt('Folder name:');
    if (!name?.trim()) return;
    const folderPath = `${parentPath}/${name.trim()}`;
    try {
      await mkdir(folderPath);
      setTree((t) => insertNode(t, parentPath, { type: 'folder', name: name.trim(), path: folderPath, children: [] }));
    } catch (err) { console.error(err); }
  }, []);

  const deleteItem = useCallback(async (path: string, type: 'file' | 'folder') => {
    if (type === 'folder') {
      setFolderDeleteState({ path, name: path.split('/').pop() ?? path });
      return;
    }
    const label = path.split('/').pop() ?? path;
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return;
    try {
      await remove(path);
      setTree((t) => removeNode(t, path));
      setCurrentFile((cf) => (cf === path ? null : cf));
    } catch (err) { alert(`Failed to delete: ${err}`); }
  }, []);

  const handleFolderDeleteAll = useCallback(async () => {
    if (!folderDeleteState) return;
    const { path } = folderDeleteState;
    setFolderDeleteState(null);
    try {
      await remove(path, { recursive: true });
      setTree((t) => removeNode(t, path));
      setCurrentFile((cf) => (!cf || cf === path || cf.startsWith(path + '/') ? null : cf));
    } catch (err) { alert(`Failed to delete: ${err}`); }
  }, [folderDeleteState]);

  const handleFolderMoveToRoot = useCallback(async () => {
    if (!folderDeleteState || !notesPath) return;
    const { path } = folderDeleteState;
    setFolderDeleteState(null);
    try {
      await moveContentsToRoot(path, notesPath);
      const fresh = await loadEntriesRecursive(notesPath);
      setTree(fresh);
      setCurrentFile((cf) => (!cf || cf === path || cf.startsWith(path + '/') ? null : cf));
    } catch (err) { alert(`Failed to move contents: ${err}`); }
  }, [folderDeleteState, notesPath]);

  const openInNewWindow = useCallback((filePath: string) => {
    if (!notesPath) return;
    const label = `note-${Date.now()}`;
    const url = `${window.location.origin}/?viewer=1&note=${encodeURIComponent(filePath)}&vault=${encodeURIComponent(notesPath)}`;
    new WebviewWindow(label, {
      url,
      title: filePath.split('/').pop()?.replace(/\.md$/, '') ?? 'Note',
      width: 920, height: 720,
    });
  }, [notesPath]);

  const renameItem = useCallback(async (oldPath: string, newBaseName: string, type: 'file' | 'folder') => {
    const dir = oldPath.slice(0, oldPath.lastIndexOf('/'));
    const newName = type === 'file' ? `${newBaseName.replace(/\.md$/, '')}.md` : newBaseName;
    const newPath = `${dir}/${newName}`;
    if (oldPath === newPath) return;
    try {
      await rename(oldPath, newPath);
      if (type === 'file') {
        setTree((t) => renameNodeInTree(t, oldPath, newPath, newName));
        setCurrentFile((cf) => (cf === oldPath ? newPath : cf));
      } else {
        const fresh = await loadEntriesRecursive(notesPath!);
        setTree(fresh);
        setCurrentFile((cf) => {
          if (!cf) return cf;
          if (cf.startsWith(oldPath + '/')) return newPath + cf.slice(oldPath.length);
          return cf;
        });
      }
    } catch (err) { alert(`Failed to rename: ${err}`); }
  }, [notesPath]);

  const moveFileToFolder = useCallback(async (sourcePath: string, targetPath: string) => {
    const filename = sourcePath.split('/').pop()!;
    const destPath = `${targetPath}/${filename}`;
    if (sourcePath === destPath || targetPath.startsWith(sourcePath + '/')) return;
    try {
      await rename(sourcePath, destPath);
      const fresh = await loadEntriesRecursive(notesPath!);
      setTree(fresh);
      setCurrentFile((cf) => (cf === sourcePath ? destPath : cf));
    } catch (err) { alert(`Failed to move: ${err}`); }
  }, [notesPath]);


  if (!notesPath) {
    return <WelcomeScreen onOpen={selectFolder} onCreate={createVault} />;
  }

  const commonTreeProps = {
    currentFile, onFileClick: setCurrentFile,
    onCreateNote: createNoteInFolder, onCreateFolder: createSubfolder,
    onDelete: deleteItem, onNewWindow: openInNewWindow,
    onRename: renameItem, onMoveFile: moveFileToFolder,
  };

  return (
    <div className="app-shell">
      <div className="app">
        {sidebarOpen ? (
          <aside className="sidebar">
            <div className="sidebar-header">
              <div className="sidebar-header-row">
                <div className="sidebar-tabs">
                  <button className={`sidebar-tab${sidebarTab === 'files' ? ' active' : ''}`}    onClick={() => setSidebarTab('files')}>Files</button>
                  <button className={`sidebar-tab${sidebarTab === 'settings' ? ' active' : ''}`} onClick={() => setSidebarTab('settings')}>Settings</button>
                </div>
                <div className="sidebar-tab-actions">
                  {sidebarTab === 'files' && <>
                    <button className="btn btn-icon" title="New note in root"  onClick={createNote}>+</button>
                    <button className="btn btn-icon" title="New folder in root" onClick={createRootFolder}>⊕</button>
                    <button className="btn btn-ghost" title="Change folder"    onClick={selectFolder}>···</button>
                  </>}
                  <button className="btn btn-icon" title="Collapse sidebar" onClick={() => setSidebarOpen(false)}>‹</button>
                </div>
              </div>
            </div>
            {sidebarTab === 'files' ? (
              <div className="file-list"
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                onDrop={(e) => {
                  e.preventDefault();
                  const src = e.dataTransfer.getData('application/charcoal-path');
                  if (src && notesPath) moveFileToFolder(src, notesPath);
                }}
              >
                {loading ? (
                  <div className="file-list-loading">Scanning…</div>
                ) : (
                  tree.map((node) => (
                    <TreeItem key={node.path} node={node} depth={0} {...commonTreeProps} />
                  ))
                )}
              </div>
            ) : (
              <SettingsPanel
                theme={theme}
                customThemes={customThemes}
                onChange={handleThemeChange}
                onReset={handleThemeReset}
                onApplyPreset={handleApplyPreset}
                onSaveCustomTheme={handleSaveCustomTheme}
                onDeleteCustomTheme={handleDeleteCustomTheme}
                onToggleBorderless={handleToggleBorderless}
              />
            )}
          </aside>
        ) : (
          <div className="sidebar-collapsed">
            <button className="btn btn-icon sidebar-expand-btn" title="Expand sidebar" onClick={() => setSidebarOpen(true)}>›</button>
          </div>
        )}
        <main className="editor-area">
          <Editor filePath={currentFile} notesPath={notesPath} showWordCount={theme.showWordCount} />
        </main>
      </div>
      {folderDeleteState && (
        <FolderDeleteModal
          folderName={folderDeleteState.name}
          onDeleteAll={handleFolderDeleteAll}
          onMoveToRoot={handleFolderMoveToRoot}
          onCancel={() => setFolderDeleteState(null)}
        />
      )}
    </div>
  );
}

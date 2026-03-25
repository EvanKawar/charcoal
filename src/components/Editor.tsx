import React, { useEffect, useRef } from 'react';
import { useEditor, EditorContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { Node, Extension, mergeAttributes, InputRule } from '@tiptap/core';
import type { NodeViewProps } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import Image from '@tiptap/extension-image';
import { Markdown } from 'tiptap-markdown';
import { readTextFile, writeTextFile, writeFile, mkdir } from '@tauri-apps/plugin-fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// ─── Module-level ref (accessible inside extension closures) ──────────────────
// We use a plain object so mutations are visible to all closures.
const _ctx = { notesPath: '' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeAttr(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/**
 * Pre-process raw markdown before feeding to the TipTap/Markdown parser:
 *   - $$...$$ → <div data-math-block="..."> (block math)
 *   - $...$ → <span data-math-inline="..."> (inline math)
 *   - relative image paths → Tauri asset URLs
 */
function preprocessMarkdown(md: string, notesPath: string): string {
  // Block math first (avoid matching by inline rule)
  let out = md.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
    return `<div data-math-block="${escapeAttr(math.trim())}"></div>`;
  });

  // Inline math — must not match $$ (already replaced) or lone $
  out = out.replace(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, (_, math) => {
    return `<span data-math-inline="${escapeAttr(math.trim())}"></span>`;
  });

  // Relative image paths in markdown syntax → Tauri asset URLs
  if (notesPath) {
    // ./relative or bare relative (no leading slash)
    out = out.replace(/!\[([^\]]*)\]\((\.\/[^)]+|[^/][^)]*\.(?:png|jpe?g|gif|webp|svg))\)/gi, (_, alt, src) => {
      const cleanSrc = src.startsWith('./') ? src.slice(2) : src;
      return `![${alt}](${convertFileSrc(`${notesPath}/${cleanSrc}`)})`;
    });
    // Absolute path fallback (e.g. /home/user/vault/assets/image.png)
    out = out.replace(/!\[([^\]]*)\]\((\/[^)]+\.(?:png|jpe?g|gif|webp|svg))\)/gi, (_, alt, src) => {
      return `![${alt}](${convertFileSrc(src)})`;
    });
    // <img> tags with relative src (width-resized images)
    out = out.replace(/<img(\s[^>]*)?\ssrc="(\.[^"]+)"([^>]*)>/gi, (_, before = '', src, after = '') => {
      const cleanSrc = src.startsWith('./') ? src.slice(2) : src;
      return `<img${before} src="${convertFileSrc(`${notesPath}/${cleanSrc}`)}"${after}>`;
    });
    // <img> tags with absolute src fallback
    out = out.replace(/<img(\s[^>]*)?\ssrc="(\/[^"]+\.(?:png|jpe?g|gif|webp|svg))"([^>]*)>/gi, (_, before = '', src, after = '') => {
      return `<img${before} src="${convertFileSrc(src)}"${after}>`;
    });
  }

  return out;
}

/**
 * Post-process the markdown string produced by getMarkdown():
 *   - Any HTML data-math-* tags that leaked through → $...$ syntax
 *   - Tauri asset URLs in image links → relative paths
 */
function postProcessMarkdown(md: string, notesPath: string): string {
  // Fallback: convert math HTML if the storage serializer didn't handle it
  let out = md.replace(/<div[^>]+data-math-block="([^"]*)"[^>]*>[\s\S]*?<\/div>/g, (_, math) => {
    return `$$\n${unescapeAttr(math)}\n$$`;
  });
  out = out.replace(/<span[^>]+data-math-inline="([^"]*)"[^>]*>[\s\S]*?<\/span>/g, (_, math) => {
    return `$${unescapeAttr(math)}$`;
  });

  // Convert asset URLs back to relative paths (markdown image syntax)
  const assetOrigin = 'https://asset.localhost';
  const toRel = (src: string) => {
    const absPath = decodeURIComponent(src.replace(assetOrigin, ''));
    return notesPath && absPath.startsWith(notesPath)
      ? '.' + absPath.slice(notesPath.length)
      : absPath;
  };
  out = out.replace(/!\[([^\]]*)\]\((https?:\/\/asset\.localhost[^)]+)\)/g, (_, alt, src) => {
    return `![${alt}](${toRel(src)})`;
  });
  // Also convert <img src="asset.localhost/..."> (resized images saved with width)
  out = out.replace(/<img(\s[^>]*)?\ssrc="(https?:\/\/asset\.localhost[^"]+)"([^>]*)>/gi, (_, before = '', src, after = '') => {
    return `<img${before} src="${toRel(src)}"${after}>`;
  });

  return out;
}

// ─── InlineMath NodeView ──────────────────────────────────────────────────────

const InlineMathView: React.FC<NodeViewProps> = ({ node, selected, updateAttributes }) => {
  const [editing, setEditing] = React.useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Enter edit mode when TipTap selects the node (e.g. arrow key or click)
  useEffect(() => {
    if (selected) setEditing(true);
  }, [selected]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = (val: string) => {
    updateAttributes({ value: val });
    setEditing(false);
  };

  if (editing) {
    return (
      <NodeViewWrapper as="span" className="math-inline-editing">
        <span className="math-delim">$</span>
        <input
          ref={inputRef}
          className="math-edit-input"
          defaultValue={node.attrs.value}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            }
          }}
        />
        <span className="math-delim">$</span>
      </NodeViewWrapper>
    );
  }

  let rendered = '';
  try {
    rendered = katex.renderToString(node.attrs.value || '', { throwOnError: false, displayMode: false });
  } catch {
    rendered = node.attrs.value || '';
  }

  return (
    <NodeViewWrapper as="span" className="math-inline" contentEditable={false}>
      <span dangerouslySetInnerHTML={{ __html: rendered }} onClick={() => setEditing(true)} />
    </NodeViewWrapper>
  );
};

// ─── BlockMath NodeView ───────────────────────────────────────────────────────

const BlockMathView: React.FC<NodeViewProps> = ({ node, selected, updateAttributes }) => {
  const [editing, setEditing] = React.useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (selected) setEditing(true);
  }, [selected]);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  const commit = (val: string) => {
    updateAttributes({ value: val });
    setEditing(false);
  };

  if (editing) {
    return (
      <NodeViewWrapper className="math-block-editing">
        <div className="math-delim">$$</div>
        <textarea
          ref={taRef}
          className="math-edit-textarea"
          defaultValue={node.attrs.value}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              commit(taRef.current?.value ?? node.attrs.value);
            }
          }}
        />
        <div className="math-delim">$$</div>
      </NodeViewWrapper>
    );
  }

  let rendered = '';
  try {
    rendered = katex.renderToString(node.attrs.value || '', { throwOnError: false, displayMode: true });
  } catch {
    rendered = node.attrs.value || '';
  }

  return (
    <NodeViewWrapper className="math-block" contentEditable={false}>
      <div dangerouslySetInnerHTML={{ __html: rendered }} onClick={() => setEditing(true)} />
    </NodeViewWrapper>
  );
};

// ─── InlineMath extension ─────────────────────────────────────────────────────

const InlineMath = Node.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return { value: { default: '' } };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-math-inline]',
        getAttrs: (dom) => ({ value: (dom as HTMLElement).getAttribute('data-math-inline') ?? '' }),
      },
    ];
  },

  renderHTML({ node }) {
    return ['span', mergeAttributes({ 'data-math-inline': node.attrs.value, class: 'math-inline' }), node.attrs.value];
  },

  addNodeView() {
    return ReactNodeViewRenderer(InlineMathView);
  },

  // Typing $expression$ converts to a math node
  addInputRules() {
    return [
      new InputRule({
        find: /(?<!\$)\$([^$\n]{1,200})\$$/,
        handler: ({ state, range, match }) => {
          const value = match[1]?.trim();
          if (!value) return;
          const node = this.type.create({ value });
          state.tr.replaceRangeWith(range.from, range.to, node);
        },
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`$${node.attrs.value}$`);
        },
        parse: {},
      },
    };
  },
});

// ─── BlockMath extension ──────────────────────────────────────────────────────

const BlockMath = Node.create({
  name: 'blockMath',
  group: 'block',
  atom: true,

  addAttributes() {
    return { value: { default: '' } };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-math-block]',
        getAttrs: (dom) => ({ value: (dom as HTMLElement).getAttribute('data-math-block') ?? '' }),
      },
    ];
  },

  renderHTML({ node }) {
    return ['div', mergeAttributes({ 'data-math-block': node.attrs.value, class: 'math-block-node' }), node.attrs.value];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BlockMathView);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`$$\n${node.attrs.value}\n$$`);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

// ─── ResizableImage NodeView ──────────────────────────────────────────────────

const ResizableImageView: React.FC<NodeViewProps> = ({ node, selected, updateAttributes }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, startX: 0, startWidth: 0 });

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const img = containerRef.current?.querySelector('img');
    if (!img) return;
    drag.current = { active: true, startX: e.clientX, startWidth: img.offsetWidth };

    const onMove = (ev: MouseEvent) => {
      if (!drag.current.active) return;
      const newWidth = Math.max(80, drag.current.startWidth + ev.clientX - drag.current.startX);
      updateAttributes({ width: Math.round(newWidth) });
    };
    const onUp = () => {
      drag.current.active = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const { src, alt, width } = node.attrs;
  return (
    <NodeViewWrapper className="image-node-wrapper" contentEditable={false}>
      <div ref={containerRef} className={`image-container${selected ? ' selected' : ''}`}>
        <img src={src} alt={alt || ''} style={{ width: width ? `${width}px` : 'auto', maxWidth: '100%' }} />
        {selected && <div className="resize-handle" onMouseDown={onMouseDown} title="Drag to resize" />}
      </div>
    </NodeViewWrapper>
  );
};

// ─── Image extension with resize + path-aware markdown serializer ─────────────

const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => {
          const w = el.getAttribute('width');
          return w ? parseInt(w, 10) : null;
        },
        renderHTML: (attrs) => (attrs.width ? { width: attrs.width } : {}),
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageView);
  },

  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: any, node: any) {
          const assetOrigin = 'https://asset.localhost';
          let src: string = node.attrs.src || '';
          if (src.startsWith(assetOrigin)) {
            const absPath = decodeURIComponent(src.slice(assetOrigin.length));
            const np = _ctx.notesPath;
            src = np && absPath.startsWith(np) ? '.' + absPath.slice(np.length) : absPath;
          }
          const alt = node.attrs.alt || '';
          const width = node.attrs.width;
          // Use HTML syntax to preserve width; plain markdown otherwise
          if (width) {
            state.write(`<img src="${src}" alt="${alt}" width="${width}">`);
          } else {
            state.write(`![${alt}](${src})`);
          }
        },
      },
    };
  },
});

// ─── Image paste extension ────────────────────────────────────────────────────

async function saveAndInsertImage(blob: File, view: any) {
  const notesPath = _ctx.notesPath;
  if (!notesPath) return;

  const assetsDir = `${notesPath}/assets`;
  try {
    await mkdir(assetsDir, { recursive: true });
  } catch {
    // already exists — fine
  }

  const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
  const filename = `image-${Date.now()}.${ext}`;
  const filePath = `${assetsDir}/${filename}`;

  const buf = await blob.arrayBuffer();
  await writeFile(filePath, new Uint8Array(buf));

  const assetUrl = convertFileSrc(filePath);
  const imageNode = view.state.schema.nodes.image.create({ src: assetUrl, alt: filename });
  view.dispatch(view.state.tr.replaceSelectionWith(imageNode));
}

const ImagePaste = Extension.create({
  name: 'imagePaste',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('imagePaste'),
        props: {
          handlePaste(view, event) {
            const items = event.clipboardData?.items;
            if (!items) return false;
            for (const item of Array.from(items)) {
              if (item.type.startsWith('image/')) {
                const blob = item.getAsFile();
                if (blob) {
                  saveAndInsertImage(blob, view).catch(console.error);
                  return true;
                }
              }
            }
            return false;
          },
        },
      }),
    ];
  },
});

// ─── Editor component ─────────────────────────────────────────────────────────

interface EditorProps {
  filePath: string | null;
  notesPath: string | null;
  showWordCount?: boolean;
}

const EditorComponent: React.FC<EditorProps> = ({ filePath, notesPath, showWordCount }) => {
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activeFile = useRef<string | null>(null);

  // Flush any pending debounced save when the component unmounts
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  // Keep the module-level context in sync so extension closures see fresh values
  useEffect(() => {
    _ctx.notesPath = notesPath ?? '';
  }, [notesPath]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      CharacterCount,
      Placeholder.configure({ placeholder: 'Start writing…' }),
      InlineMath,
      BlockMath,
      ResizableImage.configure({ inline: false, allowBase64: true }),
      ImagePaste,
      Markdown.configure({ html: true, tightLists: true, breaks: false }),
    ],
    content: '',
    editorProps: {
      attributes: { class: 'charcoal-editor', spellcheck: 'true' },
    },
    onUpdate: ({ editor }) => {
      if (!activeFile.current) return;
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const raw = (editor.storage as any).markdown.getMarkdown();
        // Use _ctx.notesPath so we always have the latest value, not a stale closure
        const clean = postProcessMarkdown(raw, _ctx.notesPath);
        writeTextFile(activeFile.current!, clean).catch(console.error);
      }, 800);
    },
  });

  // Load file whenever filePath or notesPath changes; cancel stale in-flight reads
  useEffect(() => {
    if (!editor) return;

    activeFile.current = filePath;
    // Always clear immediately — prevents stale content from the previous file showing
    editor.commands.setContent('', false as any);

    if (!filePath) return;

    let cancelled = false;
    readTextFile(filePath)
      .then((md) => {
        if (cancelled) return;
        const processed = preprocessMarkdown(md, _ctx.notesPath);
        editor.commands.setContent(processed, false as any);
        editor.commands.focus('start');
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[charcoal] readTextFile failed:', filePath, err);
        editor.commands.setContent(`<p style="color:#f38ba8">Error reading file: ${err}</p>`, false as any);
      });

    return () => { cancelled = true; };
  }, [filePath, editor]);

  if (!filePath) {
    return (
      <div className="editor-empty">
        <p>Select a note to begin editing</p>
      </div>
    );
  }

  const words = editor?.storage.characterCount?.words() ?? 0;
  const chars = editor?.storage.characterCount?.characters() ?? 0;

  return (
    <>
      <div className="editor-wrapper">
        <EditorContent editor={editor} />
      </div>
      {showWordCount && (
        <div className="word-count-bar">
          {words.toLocaleString()} words · {chars.toLocaleString()} chars
        </div>
      )}
    </>
  );
};

export default EditorComponent;

// vault-web: ホーム・設定・アカウントのページの外枠。本文の代わりに出す（本文は CSS で隠す）。
// 中身の幅と余白は、ふつうのノートの本文（.cm-content の --editor-width と左右 20px）にそろえる
import type { ComponentChildren } from "preact";

export function PageFrame({
  title,
  className,
  children,
}: {
  title: string;
  /** ページごとの見た目（.vw-home など） */
  className?: string;
  children: ComponentChildren;
}) {
  return (
    <main className="vw-page" aria-label={title}>
      <div className={className ? `vw-page-content ${className}` : "vw-page-content"}>
        <h1 className="vw-page-heading">{title}</h1>
        {children}
      </div>
    </main>
  );
}

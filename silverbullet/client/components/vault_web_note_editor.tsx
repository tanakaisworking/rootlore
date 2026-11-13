// 本文は通常のCodeMirrorのまま。右上の操作だけを保存・完了に切り替える。
import { useEffect, useState } from "preact/hooks";
import { Button } from "@silverbulletmd/silverbullet/ui";
import type { Client } from "../client.ts";
import { inlineEditor } from "../vault_web_inline_edit.ts";
import { t } from "../vault_web_i18n.ts";

export function openNoteEditor(path: string, client: Client = globalThis.client): Promise<boolean> {
  return inlineEditor(client).begin(path);
}

export function VaultWebNoteEditor({ client }: { client: Client }) {
  const editor = inlineEditor(client);
  const [, refresh] = useState(0);
  const [discarding, setDiscarding] = useState(false);
  useEffect(() => editor.subscribe(() => refresh((version) => version + 1)), [editor]);
  useEffect(() => {
    const flush = () => { editor.persist(); };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!editor.persist()) { event.preventDefault(); event.returnValue = ""; }
    };
    globalThis.addEventListener("pagehide", flush);
    globalThis.addEventListener("beforeunload", beforeUnload);
    return () => {
      globalThis.removeEventListener("pagehide", flush);
      globalThis.removeEventListener("beforeunload", beforeUnload);
    };
  }, [editor]);
  const state = editor.state;
  if (!state) return null;
  return (
    <div className="vw-inline-editor-controls" aria-label={t("ノートの編集", "Note editing")}>
      {editor.dirty && <span className="vw-inline-editor-status">{state.conflict ? t("競合あり", "Conflict") : t("未保存", "Unsaved")}</span>}
      {editor.dirty && <Button disabled={state.saving || discarding} onClick={() => {
        setDiscarding(true);
        void client.ui.confirm(t("編集内容を取り消して、保存済みの本文に戻しますか？", "Discard your edits and return to the saved note?"), { destructive: true }).then((confirmed) => {
          if (confirmed && editor.state === state) editor.discard();
        }).finally(() => setDiscarding(false));
      }}>{t("取り消す", "Discard")}</Button>}
      <Button data-rootlore-action="close" disabled={state.saving} onClick={() => void editor.close()}>{t("完了", "Done")}</Button>
      <Button data-rootlore-action="save" variant="primary" disabled={state.saving || !editor.dirty} onClick={() => void editor.save()}>
        {state.saving ? t("保存中…", "Saving…") : t("保存", "Save")}
      </Button>
    </div>
  );
}

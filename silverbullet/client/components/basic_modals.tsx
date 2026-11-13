import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { Button, Input } from "@silverbulletmd/silverbullet/ui";
import { t } from "../vault_web_i18n.ts";

export function Prompt({
  message,
  defaultValue,
  callback,
}: {
  message: string;
  defaultValue?: string;
  darkMode: boolean | undefined;
  callback: (value?: string) => void;
}) {
  const [text, setText] = useState(defaultValue || "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end); // caret at end of default value
    }
  }, []);
  const returnEl = (
    <AlwaysShownModal
      onCancel={() => {
        callback();
      }}
    >
      <div className="sb-prompt">
        <label>{message}</label>
        <Input
          inputRef={inputRef}
          class="sb-prompt-input"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          onConfirm={(value) => callback(value)}
          onExit={() => callback()}
        />
        <div className="sb-prompt-buttons">
          <Button
            shortcut="esc"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              callback();
            }}
          >
            {t("キャンセル", "Cancel")}
          </Button>
          <Button
            variant="primary"
            shortcut="⏎"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              callback(text);
            }}
          >
            {t("決定", "OK")}
          </Button>
        </div>
      </div>
    </AlwaysShownModal>
  );

  return returnEl;
}

export function Confirm({
  message,
  destructive,
  callback,
}: {
  message: string;
  destructive?: boolean;
  callback: (value: boolean) => void;
}) {
  const okButtonRef = useRef<HTMLButtonElement>(null);
  setTimeout(() => {
    okButtonRef.current?.focus();
  });
  const returnEl = (
    <AlwaysShownModal
      onCancel={() => {
        callback(false);
      }}
    >
      <div className="sb-prompt">
        <label>{message}</label>
        <div className="sb-prompt-buttons">
          <Button
            shortcut="esc"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              callback(false);
            }}
          >
            {t("キャンセル", "Cancel")}
          </Button>
          <Button
            buttonRef={okButtonRef}
            autofocus
            variant={destructive ? "danger" : "primary"}
            shortcut="⏎"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              callback(true);
            }}
          >
            {t("決定", "OK")}
          </Button>
        </div>
      </div>
    </AlwaysShownModal>
  );

  return returnEl;
}

export function AlwaysShownModal({
  children,
  onCancel,
}: {
  children: ComponentChildren;
  onCancel?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  return (
    <dialog
      className="sb-modal-box"
      onCancel={(e: Event) => {
        e.preventDefault();
        onCancel?.();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
      }}
      ref={dialogRef}
    >
      {children}
    </dialog>
  );
}

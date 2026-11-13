import { t } from "../../../vault_web_i18n.ts";

export function LoadingIndicator() {
  return <span className="sb-nav-spinner" role="status" aria-label={t("読み込み中", "Loading")} />;
}

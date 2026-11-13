// vault-web: スキルのページ。内蔵のカタログ（vault_web_skills.ts）を並べ、押すとリポジトリの `.claude/skills/<id>/` に追加する。
// 追加したスキルは、そのリポジトリで作業するエージェントがそのまま読む（Codex 用の symlink も一緒に置く）。
// 隠しフォルダはノートの一覧に出ないので、追加済みかどうかはファイルの有無を GitHub に聞く。
import { useEffect, useState } from "preact/hooks";
import { Check, Github, Package } from "preact-feather";
import { Button } from "@silverbulletmd/silverbullet/ui";
import type { Client } from "../client.ts";
import { otherRepoMessage, t } from "../vault_web_i18n.ts";
import {
  SKILLS,
  SkillInstallError,
  installSkill,
  isSkillInstalled,
  skillPaths,
  type Skill,
  type SkillGroup,
} from "../vault_web_skills.ts";
import { PageFrame } from "./vault_web_page_frame.tsx";

export function SkillsView({
  client,
  onConnect,
}: {
  client: Client;
  /** 未連携のときの「連携する」。アカウントのページを開く（vault_web_dialogs.tsx が渡す） */
  onConnect: () => void;
}) {
  const repo = client.bootConfig.githubRepo;
  // 追加済みの id。null は「まだ聞いている途中」
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const connected = !!repo;

  const apiBase = () => `${document.baseURI.replace(/\/*$/, "")}/api/gh`;

  const refresh = () => {
    if (!repo) {
      setInstalled([]);
      return;
    }
    void Promise.all(
      SKILLS.map((skill) =>
        isSkillInstalled(apiBase(), repo, skill).then(
          (yes) => (yes ? skill.id : null),
          // 読めなかったときは「まだ」で出す（押せば 409 で分かる）
          () => null,
        ),
      ),
    ).then((ids) => setInstalled(ids.filter((id): id is string => id !== null)));
  };

  useEffect(refresh, []);

  const isInstalled = (skill: Skill) => (installed ?? []).includes(skill.id);

  const install = async (skill: Skill) => {
    if (busy || isInstalled(skill)) return;
    setBusy(skill.id);
    setFailed((prev) => ({ ...prev, [skill.id]: "" }));
    try {
      await installSkill(apiBase(), skill);
      setInstalled((prev) => [...(prev ?? []), skill.id]);
      client.ui.flashNotification(
        t(`${skill.name} を追加しました`, `Added ${skill.name}`),
        "info",
      );
    } catch (e) {
      if (e instanceof SkillInstallError && e.message === "exists") {
        // 聞いたときには無かった（別のタブで追加した、など）。あるなら「追加済み」にする
        setInstalled((prev) => [...(prev ?? []), skill.id]);
        client.ui.flashNotification(
          t("すでに追加されています", "Already added"),
          "info",
        );
      } else {
        setFailed((prev) => ({
          ...prev,
          [skill.id]:
            e instanceof SkillInstallError && e.message === "login"
              ? t("ログインが切れました。読み込み直してください", "Your session expired. Reload the page.")
              : e instanceof SkillInstallError && e.message === "other-repo"
              ? otherRepoMessage()
              : t("追加できませんでした", "Couldn't add the skill"),
        }));
      }
    } finally {
      setBusy(null);
    }
  };

  // カタログは2つに分ける。OKF はノートの形をそろえる土台、ほかは置き場所の決め方で、
  // 2つ以上入れると「このノートはどこか」の答えが食い違う（vault_web_skills.ts の group）。
  const groups: { id: SkillGroup; title: string; note: string }[] = [
    {
      id: "base",
      title: t("土台（おすすめ）", "Base (recommended)"),
      note: t(
        "ノートの形をそろえるスキルです。ほかのスキルと組み合わせて使えます。",
        "Shapes your notes. Works alongside any of the skills below.",
      ),
    },
    {
      id: "layout",
      title: t("フォルダの決め方（どれか1つ）", "Folder layout (pick one)"),
      note: t(
        "「このノートをどこに置くか」の決め方が入っています。2つ以上入れると、置き場所の答えが食い違います。",
        "Each of these decides where a note goes. Installing more than one gives conflicting answers.",
      ),
    },
  ];

  return (
    <PageFrame title={t("スキル", "Skills")} className="vw-skills">
      <p className="vw-skills-lead">
        {t(
          "リポジトリを整えるためのスキルを選んで、このリポジトリに追加できます。追加したスキルは .claude/skills/ に置かれ、そのリポジトリで作業するエージェントが読みます（Codex 用に .agents/skills/ へ symlink も1本置きます）。",
          "Pick a skill for keeping this repository in shape. It is written to .claude/skills/ so agents working in this repository read it, with a symlink under .agents/skills/ for Codex.",
        )}
      </p>

      {!connected && (
        <p className="vw-skills-note">
          <Package size={16} aria-hidden="true" />
          <span>
            {t(
              "先にリポジトリを連携してください。",
              "Connect your repository first.",
            )}
          </span>
          <Button onClick={onConnect}>{t("連携する", "Connect")}</Button>
        </p>
      )}

      {groups.map((group) => {
        const items = SKILLS.filter((skill) => skill.group === group.id);
        if (items.length === 0) return null;
        return (
          <section className="vw-skill-group" key={group.id}>
            <div className="vw-skill-group-head">
              <h3 className="vw-skill-group-title">{group.title}</h3>
              <p className="vw-skill-group-note">{group.note}</p>
            </div>
            {items.map((skill) => {
              const added = isInstalled(skill);
              const state = busy === skill.id ? "busy" : added ? "done" : "idle";
              return (
                <article className="vw-skill" key={skill.id}>
                  <div className="vw-skill-head">
                    <Package
                      size={18}
                      aria-hidden="true"
                      className="vw-skill-icon"
                    />
                    <span className="vw-skill-title">
                      <span className="vw-skill-name">{skill.name}</span>
                      <a
                        className="vw-skill-source"
                        href={skill.source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {skill.source.label}
                      </a>
                    </span>
                    {added && (
                      <span className="vw-skill-badge">
                        <Check size={12} aria-hidden="true" />
                        {t("追加済み", "Added")}
                      </span>
                    )}
                  </div>
                  <p className="vw-skill-summary">{skill.summary}</p>
                  <ul className="vw-skill-does">
                    {skill.does.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <div className="vw-skill-foot">
                    {/* 置き場所は1つだけ出す。.agents/skills の symlink は上の説明に書いてある */}
                    <span className="vw-skill-path">
                      {skillPaths(skill).join(", ")}
                    </span>
                    <span className="vw-skill-actions">
                      <a
                        className="vw-skill-link"
                        href={skill.source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Github size={14} aria-hidden="true" />
                        {t("出典", "Source")}
                      </a>
                      <Button
                        disabled={!connected || state !== "idle"}
                        onClick={() => void install(skill)}
                      >
                        {state === "busy"
                          ? t("追加中…", "Adding…")
                          : added
                            ? t("追加済み", "Added")
                            : t("追加する", "Add")}
                      </Button>
                    </span>
                  </div>
                  {failed[skill.id] && (
                    <p className="vw-skill-error">{failed[skill.id]}</p>
                  )}
                </article>
              );
            })}
          </section>
        );
      })}
    </PageFrame>
  );
}

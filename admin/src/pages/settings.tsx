// 站点设置：照 shared 里的 SETTING_FIELDS 按分组自动生成表单。
// 改过的项高亮，「保存」只发改过的项；服务端 422 时把原因贴在对应项下面；没有 settings.write 权限就只读。

import { useEffect, useMemo, useState } from "preact/hooks";

import { DEFAULT_SETTINGS, SETTING_FIELDS, type SettingField, type Settings } from "../../../shared/types";
import { api } from "../api";
import { ApiError, errorMessage } from "../lib/errors";
import { checkSettingValue, diffSettings, formatDefault, groupFields, isChanged } from "../lib/settings-diff";
import { Async, Badge, Card, Notice, PageHeader } from "../ui/components";
import { Switch } from "../ui/controls";
import { useLeaveGuard, useResource } from "../ui/hooks";
import { setSiteName, useCan } from "../ui/session";
import { toast } from "../ui/toast";

function range(field: SettingField): string {
  if (field.type !== "int") return "";
  return `范围 ${field.min ?? "—"}–${field.max ?? "—"}`;
}

function FieldControl({ field, value, disabled, invalid, onChange }: { field: SettingField; value: Settings[keyof Settings]; disabled: boolean; invalid: boolean; onChange: (value: Settings[keyof Settings]) => void }) {
  const id = `setting-${field.key}`;
  if (field.type === "bool") return <Switch checked={value === true} disabled={disabled} label={field.label} onChange={onChange} />;
  if (field.type === "int") {
    return (
      <input
        id={id}
        class="input input-num"
        type="number"
        inputMode="numeric"
        min={field.min}
        max={field.max}
        step={1}
        disabled={disabled}
        aria-invalid={invalid}
        value={typeof value === "number" && !Number.isNaN(value) ? value : ""}
        onInput={(event) => {
          const raw = event.currentTarget.value;
          onChange(raw === "" ? Number.NaN : Number(raw));
        }}
      />
    );
  }
  if (field.type === "lines") {
    return <textarea id={id} class="textarea mono" rows={5} disabled={disabled} aria-invalid={invalid} spellcheck={false} value={String(value)} onInput={(event) => onChange(event.currentTarget.value)} />;
  }
  return <input id={id} class="input" type="text" maxLength={60} disabled={disabled} aria-invalid={invalid} value={String(value)} onInput={(event) => onChange(event.currentTarget.value)} />;
}

function SettingsForm({ base, canWrite, onSaved }: { base: Settings; canWrite: boolean; onSaved: (settings: Settings) => void }) {
  const [draft, setDraft] = useState<Settings>(base);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [unknownKeys, setUnknownKeys] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(base), [base]);

  const patch = useMemo(() => diffSettings(base, draft), [base, draft]);
  const changedKeys = new Set<string>(Object.keys(patch));
  // 只预检改过的项（没改的是服务端存的值，一定合法）
  const clientErrors: Record<string, string> = {};
  for (const field of SETTING_FIELDS) {
    if (!changedKeys.has(field.key)) continue;
    const problem = checkSettingValue(field, draft[field.key]);
    if (problem) clientErrors[field.key] = problem;
  }
  const hasClientErrors = Object.keys(clientErrors).length > 0;
  useLeaveGuard(canWrite && changedKeys.size > 0);

  function change(field: SettingField, value: Settings[keyof Settings]): void {
    setDraft((current) => ({ ...current, [field.key]: value }));
    setServerErrors((current) => {
      if (!(field.key in current)) return current;
      const { [field.key]: _removed, ...rest } = current;
      return rest;
    });
  }

  function discard(): void {
    setDraft(base);
    setServerErrors({});
    setUnknownKeys([]);
  }

  async function save(): Promise<void> {
    if (changedKeys.size === 0 || hasClientErrors) return;
    setSaving(true);
    setServerErrors({});
    setUnknownKeys([]);
    try {
      const result = await api.saveSettings(patch);
      toast.success(`已保存 ${changedKeys.size} 项设置`);
      setSiteName(result.settings.siteName);
      onSaved(result.settings);
    } catch (error) {
      if (error instanceof ApiError && error.code === "invalid_settings") {
        const fields = error.fieldErrors;
        setServerErrors(fields);
        setUnknownKeys(Object.keys(fields).filter((key) => !SETTING_FIELDS.some((field) => field.key === key)));
        toast.error(`有 ${Object.keys(fields).length} 项设置没通过校验，见下面标红的项（整批都没有保存）`);
      } else {
        toast.error(errorMessage(error));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      class="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {!canWrite ? <Notice tone="info">你没有修改设置的权限（需要管理员或站长），这里只能查看。</Notice> : null}
      {Object.keys(serverErrors).length > 0 ? (
        <Notice tone="error">
          服务端拒绝了这次修改，请看下面标红的项；整批都没有保存。
          {unknownKeys.length > 0 ? `（还有不认识的设置项：${unknownKeys.join("、")}）` : ""}
        </Notice>
      ) : null}

      {groupFields().map((group) => (
        <Card key={group.group} title={group.group}>
          <div class="settings-list">
            {group.fields.map((field) => {
              const changed = changedKeys.has(field.key);
              const error = serverErrors[field.key] ?? clientErrors[field.key] ?? null;
              const differsFromDefault = isChanged(field, DEFAULT_SETTINGS, draft);
              return (
                <div class={`setting ${changed ? "is-changed" : ""} ${error ? "has-error" : ""}`} key={field.key}>
                  <div class="setting-head">
                    <label class="setting-label" htmlFor={field.type === "bool" ? undefined : `setting-${field.key}`}>
                      {field.label}
                    </label>
                    {changed ? <Badge tone="blue">已修改</Badge> : null}
                  </div>
                  <div class="setting-control">
                    <FieldControl field={field} value={draft[field.key]} disabled={!canWrite || saving} invalid={Boolean(error)} onChange={(value) => change(field, value)} />
                  </div>
                  {field.help ? <div class="setting-help">{field.help}</div> : null}
                  <div class="setting-meta muted small">
                    默认：{formatDefault(field)}
                    {range(field) ? ` · ${range(field)}` : ""}
                    {canWrite && differsFromDefault ? (
                      <>
                        {" · "}
                        <button type="button" class="link-btn" disabled={saving} onClick={() => change(field, DEFAULT_SETTINGS[field.key])}>
                          改回默认
                        </button>
                      </>
                    ) : null}
                  </div>
                  {error ? (
                    <div class="field-error" role="alert">
                      {error}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
      ))}

      {canWrite ? (
        <div class={`save-bar ${changedKeys.size > 0 ? "is-dirty" : ""}`}>
          <span class="save-bar-text">{changedKeys.size > 0 ? `有 ${changedKeys.size} 项改动还没保存` : "没有未保存的改动"}</span>
          <button type="button" class="btn" disabled={changedKeys.size === 0 || saving} onClick={discard}>
            放弃改动
          </button>
          <button type="submit" class="btn btn-primary" disabled={changedKeys.size === 0 || saving || hasClientErrors}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      ) : null}
    </form>
  );
}

export function SettingsPage() {
  const canWrite = useCan("settings.write");
  const res = useResource(() => api.settings(), []);
  return (
    <>
      <PageHeader title="站点设置" subtitle="站点名称、审核规则、频率限制、自动检查……改完点「保存」立即生效。" />
      <Async res={res}>{({ settings }) => <SettingsForm base={settings} canWrite={canWrite} onSaved={(saved) => res.mutate(() => ({ settings: saved }))} />}</Async>
    </>
  );
}

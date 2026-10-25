import { ChevronDown, RefreshCw, Zap } from 'lucide-react'
import type { CatalogSkill } from '../../../shared/catalog'
import type { Effort } from '../../../shared/contracts'
import { refreshDiagnostics, useAppStore } from '../store'

export function SkillSelector({
  skills,
  selected,
  onChange,
  disabled = false,
  requiredIds = [],
}: {
  skills: CatalogSkill[]
  selected: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
  requiredIds?: string[]
}) {
  const available = skills.filter((skill) => !skill.removedAt)
  const missing = selected.filter(
    (id) =>
      !available.some((skill) => skill.id === id) && !requiredIds.includes(id),
  )
  return (
    <div className="catalog-skill-selector">
      {available.length ? (
        available.map((skill) => {
          const checked = selected.includes(skill.id)
          const required = requiredIds.includes(skill.id)
          return (
            <label
              key={skill.id}
              className={`catalog-skill-choice ${checked ? 'checked' : ''}`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={
                  disabled || required || (!checked && selected.length >= 20)
                }
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, skill.id]
                      : selected.filter((id) => id !== skill.id),
                  )
                }
              />
              <span>
                <strong>
                  {skill.name}
                  <small>
                    {skill.projectId ? 'Project' : 'Global'}
                    {required ? ' · profile' : ''}
                  </small>
                </strong>
                <p>{skill.description}</p>
              </span>
              <Zap size={12} />
            </label>
          )
        })
      ) : (
        <p className="helper">
          No active skills are available in this scope. Add one in Skills.
        </p>
      )}
      {missing.length > 0 && (
        <div className="selector-missing">
          <p>{missing.length} selected skill(s) are unavailable.</p>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              onChange(selected.filter((id) => !missing.includes(id)))
            }
          >
            Remove unavailable selections
          </button>
        </div>
      )}
    </div>
  )
}

export function ModelFields({
  model,
  effort,
  onModel,
  onEffort,
  disabled = false,
  idPrefix = 'profile',
}: {
  model: string
  effort: Effort | ''
  onModel: (value: string) => void
  onEffort: (value: Effort | '') => void
  disabled?: boolean
  idPrefix?: string
}) {
  const models = useAppStore((state) => state.state?.diagnostics?.models)
  const checking = useAppStore((state) => state.checking)
  const option = models?.find((option) => option.id === model)
  return (
    <div className="catalog-model-fields">
      <div>
        <label htmlFor={`${idPrefix}-model`}>Default model</label>
        <div className="select-wrap">
          <select
            id={`${idPrefix}-model`}
            value={model}
            disabled={disabled}
            onChange={(event) => {
              onModel(event.target.value)
              onEffort('')
            }}
          >
            <option value="">Configured default</option>
            {model && !option && (
              <option value={model}>{model} (unavailable)</option>
            )}
            {models?.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </div>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-effort`}>Reasoning effort</label>
        <div className="select-wrap">
          <select
            id={`${idPrefix}-effort`}
            value={effort}
            disabled={disabled || !option}
            onChange={(event) => onEffort(event.target.value as Effort | '')}
          >
            <option value="">Model default</option>
            {effort && !option?.efforts.includes(effort) && (
              <option value={effort}>{effort} (unavailable)</option>
            )}
            {option?.efforts.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </div>
      </div>
      <p className="helper">Model options come from your local runtime.</p>
      <button
        type="button"
        className="icon-button"
        disabled={disabled || checking}
        onClick={() => void refreshDiagnostics()}
        aria-label="Refresh model options"
      >
        <RefreshCw size={13} className={checking ? 'spin' : ''} />
      </button>
    </div>
  )
}

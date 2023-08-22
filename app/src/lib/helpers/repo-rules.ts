import { RE2JS } from 're2js'
import {
  RepoRulesInfo,
  IRepoRulesMetadataRule,
  RepoRulesMetadataMatcher,
  RepoRuleEnforced,
} from '../../models/repo-rules'
import {
  APIRepoRuleMetadataOperator,
  APIRepoRuleType,
  IAPIRepoRule,
  IAPIRepoRuleMetadataParameters,
  IAPIRepoRuleset,
} from '../api'
import { enableRepoRulesBeta } from '../feature-flag'
import { supportsRepoRules } from '../endpoint-capabilities'
import { Account } from '../../models/account'
import {
  Repository,
  isRepositoryWithGitHubRepository,
} from '../../models/repository'
import { minimatch, MinimatchOptions } from 'minimatch'

// these are chosen to make the minimatch behavior match
// Ruby's File.fnmatch behavior with only the `File::FNM_PATHNAME`
// flag set
export const REPO_RULES_MINIMATCH_OPTIONS: MinimatchOptions = {
  nobrace: true,
  nocomment: true,
  noext: true,
  // noglobstar: true,
  nonegate: true,
  optimizationLevel: 0,
  preserveMultipleSlashes: true,
}

/**
 * Returns whether repo rules could potentially exist for the provided account and repository.
 * This only performs client-side checks, such as whether the user is on a free plan
 * and the repo is public.
 */
export function useRepoRulesLogic(
  account: Account | null,
  repository: Repository
): boolean {
  if (
    !account ||
    !repository ||
    !enableRepoRulesBeta() ||
    !isRepositoryWithGitHubRepository(repository)
  ) {
    return false
  }

  const { endpoint, owner, isPrivate } = repository.gitHubRepository

  if (!supportsRepoRules(endpoint)) {
    return false
  }

  // repo owner's plan can't be checked, only the current user's. purposely return true
  // if the repo owner is someone else, because if the current user is a collaborator on
  // the free plan but the owner is a pro member, then repo rules could still be enabled.
  // errors will be thrown by the API in this case, but there's no way to preemptively
  // check for that.
  if (
    account.login === owner.login &&
    (!account.plan || account.plan === 'free') &&
    isPrivate
  ) {
    return false
  }

  return true
}

/**
 * Parses the GitHub API response for a branch's repo rules into a more useable
 * format.
 */
export function parseRepoRules(
  rules: ReadonlyArray<IAPIRepoRule>,
  rulesets: ReadonlyMap<number, IAPIRepoRuleset>
): RepoRulesInfo {
  const info = new RepoRulesInfo()

  for (const rule of rules) {
    // if a ruleset is null/undefined, then act as if the rule doesn't exist because
    // we don't know what will happen when they push
    const ruleset = rulesets.get(rule.ruleset_id)
    if (ruleset == null) {
      continue
    }

    // a rule may be configured multiple times, and the strictest value always applies.
    // since the rule will not exist in the API response if it's not enforced, we know
    // we're always assigning either 'bypass' or true below. therefore, we only need
    // to check if the existing value is true, otherwise it can always be overridden.
    const enforced =
      ruleset.current_user_can_bypass === 'always' ? 'bypass' : true

    switch (rule.type) {
      case APIRepoRuleType.Update:
      case APIRepoRuleType.RequiredDeployments:
      case APIRepoRuleType.RequiredSignatures:
      case APIRepoRuleType.RequiredStatusChecks:
        info.basicCommitWarning =
          info.basicCommitWarning !== true ? enforced : true
        break

      case APIRepoRuleType.Creation:
        info.creationRestricted =
          info.creationRestricted !== true ? enforced : true
        break

      case APIRepoRuleType.PullRequest:
        info.pullRequestRequired =
          info.pullRequestRequired !== true ? enforced : true
        break

      case APIRepoRuleType.CommitMessagePattern:
        info.commitMessagePatterns.push(toMetadataRule(rule, enforced))
        break

      case APIRepoRuleType.CommitAuthorEmailPattern:
        info.commitAuthorEmailPatterns.push(toMetadataRule(rule, enforced))
        break

      case APIRepoRuleType.CommitterEmailPattern:
        info.committerEmailPatterns.push(toMetadataRule(rule, enforced))
        break

      case APIRepoRuleType.BranchNamePattern:
        info.branchNamePatterns.push(toMetadataRule(rule, enforced))
        break
    }
  }

  return info
}

/**
 * Returns rulesets that apply to the provided branch name by performing an fnmatch-style check.
 */
export function getRulesetsApplicableToBranchName(
  branchName: string,
  rulesets: ReadonlyMap<number, IAPIRepoRuleset>,
  defaultBranchName: string | null
): ReadonlyArray<IAPIRepoRuleset> {
  const applicableRulesets: IAPIRepoRuleset[] = []

  if (!branchName || rulesets.size === 0) {
    return applicableRulesets
  }

  for (const rs of rulesets.values()) {
    const included = rs.conditions?.ref_name?.include
    const excluded = rs.conditions?.ref_name?.exclude

    // if there are no rules, then there's nothing to match against
    if (
      (!included || included.length === 0) &&
      (!excluded || excluded.length === 0)
    ) {
      continue
    }

    let applies = branchNameMatchesPatterns(
      branchName,
      included,
      defaultBranchName,
      true
    )

    // no need to check exclusions if it doesn't match the inclusions
    if (!applies) {
      continue
    }

    applies = !branchNameMatchesPatterns(
      branchName,
      excluded,
      defaultBranchName,
      false
    )

    if (applies) {
      applicableRulesets.push(rs)
    }
  }

  return applicableRulesets
}

function branchNameMatchesPatterns(
  branchName: string,
  patterns: ReadonlyArray<string> | undefined,
  defaultBranchName: string | null,
  matchKeywords: boolean
): boolean {
  for (const p of patterns ?? []) {
    if (
      matchKeywords &&
      (p === '~ALL' ||
        (p === '~DEFAULT' &&
          defaultBranchName &&
          defaultBranchName === branchName))
    ) {
      return true
    }

    if (minimatch.match([branchName], p, REPO_RULES_MINIMATCH_OPTIONS).length > 0) {
      return true
    }
  }

  return false
}

function toMetadataRule(
  rule: IAPIRepoRule | undefined,
  enforced: RepoRuleEnforced
): IRepoRulesMetadataRule | undefined {
  if (!rule?.parameters) {
    return undefined
  }

  return {
    enforced,
    matcher: toMatcher(rule.parameters),
    humanDescription: toHumanDescription(rule.parameters),
    rulesetId: rule.ruleset_id,
  }
}

function toHumanDescription(apiParams: IAPIRepoRuleMetadataParameters): string {
  let description = 'must '
  if (apiParams.negate) {
    description += 'not '
  }

  if (apiParams.operator === APIRepoRuleMetadataOperator.RegexMatch) {
    return description + `match the regular expression "${apiParams.pattern}"`
  }

  switch (apiParams.operator) {
    case APIRepoRuleMetadataOperator.StartsWith:
      description += 'start with '
      break

    case APIRepoRuleMetadataOperator.EndsWith:
      description += 'end with '
      break

    case APIRepoRuleMetadataOperator.Contains:
      description += 'contain '
      break
  }

  return description + `"${apiParams.pattern}"`
}

/**
 * Converts the given metadata rule into a matcher function that uses regex to test the rule.
 */
function toMatcher(
  rule: IAPIRepoRuleMetadataParameters | undefined
): RepoRulesMetadataMatcher {
  if (!rule) {
    return () => false
  }

  let regex: RE2JS

  switch (rule.operator) {
    case APIRepoRuleMetadataOperator.StartsWith:
      regex = RE2JS.compile(`^${RE2JS.quote(rule.pattern)}`)
      break

    case APIRepoRuleMetadataOperator.EndsWith:
      regex = RE2JS.compile(`${RE2JS.quote(rule.pattern)}$`)
      break

    case APIRepoRuleMetadataOperator.Contains:
      regex = RE2JS.compile(`.*${RE2JS.quote(rule.pattern)}.*`)
      break

    case APIRepoRuleMetadataOperator.RegexMatch:
      regex = RE2JS.compile(rule.pattern)
      break
  }

  if (regex) {
    if (rule.negate) {
      return (toMatch: string) => !regex.matcher(toMatch).find()
    } else {
      return (toMatch: string) => regex.matcher(toMatch).find()
    }
  } else {
    return () => false
  }
}

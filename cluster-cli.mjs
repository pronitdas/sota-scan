#!/usr/bin/env node
// ── sota-scan deterministic clustering CLI (OpenCode port) ─────────────────────
//
// In Claude Code the sota-scan-fanout *Workflow* ran lib/cluster.mjs in-process.
// OpenCode has no Workflow runtime, but it DOES have a real filesystem + Node, so
// here the same deterministic core runs as an ordinary script. The SKILL pipes
// JSON through two subcommands that sandwich the (model-driven) synthesis stage:
//
//   1) cluster   — group candidates into peer clusters, classify OUR repo, pick
//                  direct vs reference comparators.  (BEFORE synthesis)
//   2) finalize  — take the model's synthesis + the cluster output and enforce the
//                  honest gap sectioning + tier deterministically.  (AFTER synthesis)
//
// Both read JSON from stdin and write JSON to stdout, so they compose with the
// shell:  node cluster-cli.mjs cluster < candidates.json > cluster.json
//
// This file imports lib/cluster.mjs (the SOURCE OF TRUTH) — it adds no scoring
// logic of its own, it only wires the exported functions together exactly the way
// the Claude Code workflow did.
// ─────────────────────────────────────────────────────────────────────────────

import {
  clusterCandidates,
  classifyRepo,
  selectBenchmarks,
  explainSelection,
  partitionGaps,
  countTableStakesGaps,
  tierFor,
} from './lib/cluster.mjs'

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => (buf += d))
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', reject)
  })
}

function die(msg) {
  process.stderr.write(`cluster-cli: ${msg}\n`)
  process.exit(1)
}

// ── cluster: profiles + us_profile → clusters, classification, selection ───────
// input:  { profiles:[<PROFILE>...], us_profile:<US_PROFILE>|null, now:"YYYY-MM-DD"|null }
// output: everything the synthesis stage and the finalize stage need.
function runCluster(input) {
  const profiles = Array.isArray(input.profiles) ? input.profiles.filter(Boolean) : []
  if (!profiles.length) die('no profiles passed to `cluster`')
  const usProfile = input.us_profile || null
  const now = input.now || null

  const { clusters, merges } = clusterCandidates(profiles)
  const classification = classifyRepo(usProfile, clusters)
  const selection = selectBenchmarks(clusters, classification, { now })
  const explanation = explainSelection(classification, clusters, selection, {
    domain: input.domain || 'unknown',
  })

  const profileByRepo = new Map(profiles.map((p) => [p.repo, p]))
  const directProfiles = selection.directProfiles || []
  const referenceProfiles = selection.references
    .map((r) => profileByRepo.get(r.repo))
    .filter(Boolean)

  return {
    clusters: clusters.map((c) => ({
      id: c.id,
      size: c.size,
      members: c.members.map((m) => m.repo),
      mergedFrom: c.mergedFrom,
    })),
    merges,
    user_cluster: {
      id: selection.primaryClusterId,
      confidence: classification.confidence,
      degraded: !!selection.degraded,
      reason: classification.reason,
      secondary: classification.secondary,
    },
    selection: {
      direct: selection.direct,
      references: selection.references,
      excluded: selection.excluded,
      degraded: !!selection.degraded,
      note: selection.note,
    },
    selection_explanation: explanation.lines,
    // full profile objects the synthesis subagent needs as input:
    directProfiles,
    referenceProfiles,
    // kept so `finalize` can rebuild the leaderboard without re-reading anything:
    allProfiles: profiles,
  }
}

// ── finalize: cluster output + model synthesis → final, tier-correct result ────
// input: { domain, now, cluster:<output of `cluster`>, synthesis:{rubric,matrix,coverage,gaps} }
function runFinalize(input) {
  const cluster = input.cluster
  const synth = input.synthesis
  if (!cluster) die('finalize: missing `cluster` (output of the cluster step)')
  if (!synth) die('finalize: missing `synthesis` (the model matrix+gaps object)')

  const primaryClusterId = cluster.user_cluster ? cluster.user_cluster.id : null
  const buckets = partitionGaps(synth.gaps || [], { primaryClusterId })
  const gapsTotal = countTableStakesGaps(buckets)
  const tier = tierFor(gapsTotal)

  const profileByRepo = new Map((cluster.allProfiles || []).map((p) => [p.repo, p]))
  const directProfiles = cluster.directProfiles || []
  const references = (cluster.selection && cluster.selection.references) || []

  const field = [
    ...directProfiles.map((p) => ({
      repo: p.repo,
      cluster: p.cluster_label,
      role: 'direct',
      type: p.type || null,
      stars: (p.maturity || {}).stars ?? null,
      pushed: (p.maturity || {}).last_commit ?? null,
      why: p.why || '',
    })),
    ...references.map((r) => ({
      repo: r.repo,
      cluster: r.cluster,
      role: 'reference',
      stars: ((profileByRepo.get(r.repo) || {}).maturity || {}).stars ?? null,
      why: r.why,
    })),
  ]

  return {
    domain: input.domain || 'unknown-domain',
    clusters: cluster.clusters,
    merges: cluster.merges,
    user_cluster: cluster.user_cluster,
    selection: cluster.selection,
    selection_explanation: cluster.selection_explanation,
    field,
    rubric: synth.rubric,
    matrix: synth.matrix,
    coverage: synth.coverage,
    tier,
    gaps_total: gapsTotal,
    gaps: buckets,
  }
}

const cmd = process.argv[2]
const raw = await readStdin()
let input
try {
  input = raw.trim() ? JSON.parse(raw) : {}
} catch (e) {
  die(`could not parse stdin as JSON: ${e.message}`)
}

let out
if (cmd === 'cluster') out = runCluster(input)
else if (cmd === 'finalize') out = runFinalize(input)
else die(`unknown subcommand "${cmd || ''}" — use "cluster" or "finalize"`)

process.stdout.write(JSON.stringify(out, null, 2) + '\n')

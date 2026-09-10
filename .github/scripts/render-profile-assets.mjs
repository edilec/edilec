import {mkdir, writeFile} from "node:fs/promises"
import {resolve} from "node:path"

const API_ORIGIN = "https://api.github.com"
const PROFILE_LOGIN = process.env.PROFILE_LOGIN
const PROFILE_LABEL = process.env.PROFILE_LABEL ?? PROFILE_LOGIN
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
const OUTPUT_DIRECTORY = resolve(process.argv[2] ?? "assets/profile")

if (!PROFILE_LOGIN)
  throw new Error("PROFILE_LOGIN is required")
if (!TOKEN)
  throw new Error("GITHUB_TOKEN or GH_TOKEN is required")

const XML_ESCAPE = value => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;")

function request(path, options = {}) {
  return fetch(`${API_ORIGIN}${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "user-agent": "edilec-local-profile-assets",
      "x-github-api-version": "2022-11-28",
      ...(options.headers ?? {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  }).then(async response => {
    const body = await response.json()
    if (!response.ok)
      throw new Error(`GitHub API request failed with status ${response.status}`)
    return body
  })
}

async function loadProfile() {
  const [profile, contributionResponse] = await Promise.all([
    request(`/users/${encodeURIComponent(PROFILE_LOGIN)}`),
    loadContributions(),
  ])
  return {profile, contributions: contributionResponse}
}

async function loadContributions() {
  const end = new Date()
  end.setUTCHours(23, 59, 59, 999)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 365)
  start.setUTCHours(0, 0, 0, 0)
  const query = `
    query($login:String!, $from:DateTime!, $to:DateTime!) {
      user(login:$login) {
        contributionsCollection(from:$from, to:$to) {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                date
                weekday
                contributionLevel
              }
            }
          }
        }
      }
    }
  `
  const response = await request("/graphql", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({
      query,
      variables: {
        login: PROFILE_LOGIN,
        from: start.toISOString(),
        to: end.toISOString(),
      },
    }),
  })
  if (response.errors?.length)
    throw new Error(response.errors.map(error => error.message).join("; "))
  const collection = response.data?.user?.contributionsCollection
  if (!collection?.contributionCalendar?.weeks?.length)
    throw new Error(`No contribution calendar returned for ${PROFILE_LOGIN}`)
  return {collection, start, end}
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)
}

function fontFamily() {
  return "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
}

function metricCard(x, label, value) {
  return `<g>
    <rect x="${x}" y="94" width="264" height="94" rx="14" fill="#ffffff" stroke="#d0d7de"/>
    <text x="${x + 18}" y="123" fill="#57606a" font-family="${fontFamily()}" font-size="11" font-weight="700" letter-spacing="1.2">${XML_ESCAPE(label)}</text>
    <text x="${x + 18}" y="160" fill="#116329" font-family="${fontFamily()}" font-size="28" font-weight="750">${XML_ESCAPE(value)}</text>
  </g>`
}

function renderActivity({profile, collection, end}) {
  const summary = collection.contributionCalendar
  const values = [
    ["PUBLIC REPOSITORIES", profile.public_repos],
    ["CONTRIBUTIONS", summary.totalContributions],
    ["COMMITS", collection.totalCommitContributions],
    ["PULL REQUESTS", collection.totalPullRequestContributions],
  ]
  const cards = values.map(([label, value], index) => metricCard(36 + index * 282, label, value)).join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 250" width="1200" height="250" role="img" aria-labelledby="activity-title activity-desc" data-component="github-activity" data-schema="1" data-profile="${XML_ESCAPE(PROFILE_LOGIN)}" data-as-of="${XML_ESCAPE(end.toISOString())}">
  <title id="activity-title">${XML_ESCAPE(PROFILE_LABEL)} GitHub activity</title>
  <desc id="activity-desc">A local snapshot of public repositories and GitHub contributions through ${XML_ESCAPE(formatDate(end))}.</desc>
  <rect x=".5" y=".5" width="1199" height="249" rx="18" fill="#f6f8fa" stroke="#d0d7de"/>
  <text x="36" y="37" fill="#116329" font-family="${fontFamily()}" font-size="11" font-weight="750" letter-spacing="2">GITHUB ACTIVITY</text>
  <text x="36" y="67" fill="#1f2328" font-family="${fontFamily()}" font-size="24" font-weight="750">${XML_ESCAPE(PROFILE_LABEL)} · local profile signal</text>
  ${cards}
  <text x="36" y="221" fill="#57606a" font-family="${fontFamily()}" font-size="12">Generated from GitHub account data on ${XML_ESCAPE(formatDate(end))}. The image is stored in this profile repository.</text>
</svg>
`
}

function levelColor(level) {
  return {
    NONE: "#ebedf0",
    FIRST_QUARTILE: "#d7f0df",
    SECOND_QUARTILE: "#a8dfb8",
    THIRD_QUARTILE: "#55b878",
    FOURTH_QUARTILE: "#1f883d",
  }[level] ?? "#ebedf0"
}

function renderContributionGrid({collection, end}) {
  const calendar = collection.contributionCalendar
  const weeks = calendar.weeks
  const gridX = 36
  const gridY = 144
  const stride = 16
  const cell = 12
  const cells = []
  const monthLabels = []
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const week = weeks[weekIndex]
    for (const day of week.contributionDays) {
      const x = gridX + weekIndex * stride
      const y = gridY + Number(day.weekday) * stride
      cells.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${levelColor(day.contributionLevel)}"><title>${XML_ESCAPE(day.contributionCount)} contributions on ${XML_ESCAPE(day.date)}</title></rect>`)
      if (day.date.endsWith("-01"))
        monthLabels.push(`<text x="${x}" y="132" fill="#57606a" font-family="${fontFamily()}" font-size="10">${XML_ESCAPE(new Intl.DateTimeFormat("en-GB", {month: "short", timeZone: "UTC"}).format(new Date(`${day.date}T00:00:00Z`)))}</text>`)
    }
  }

  const legend = ["NONE", "FIRST_QUARTILE", "SECOND_QUARTILE", "THIRD_QUARTILE", "FOURTH_QUARTILE"]
    .map((level, index) => `<rect x="${966 + index * 18}" y="278" width="12" height="12" rx="2" fill="${levelColor(level)}"/>`).join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 310" width="1200" height="310" role="img" aria-labelledby="grid-title grid-desc" data-component="contribution-grid" data-schema="1" data-profile="${XML_ESCAPE(PROFILE_LOGIN)}" data-as-of="${XML_ESCAPE(end.toISOString())}" data-total="${XML_ESCAPE(calendar.totalContributions)}">
  <title id="grid-title">${XML_ESCAPE(PROFILE_LABEL)} contribution activity</title>
  <desc id="grid-desc">A locally stored contribution calendar covering the last year through ${XML_ESCAPE(formatDate(end))}, with ${XML_ESCAPE(calendar.totalContributions)} contributions.</desc>
  <rect x=".5" y=".5" width="1199" height="309" rx="18" fill="#ffffff" stroke="#d0d7de"/>
  <text x="36" y="37" fill="#116329" font-family="${fontFamily()}" font-size="11" font-weight="750" letter-spacing="2">CONTRIBUTION CALENDAR</text>
  <text x="36" y="68" fill="#1f2328" font-family="${fontFamily()}" font-size="24" font-weight="750">${XML_ESCAPE(calendar.totalContributions)} contributions in the last year</text>
  <text x="36" y="91" fill="#57606a" font-family="${fontFamily()}" font-size="12">${XML_ESCAPE(formatDate(new Date(calendar.weeks[0].contributionDays[0].date)))} – ${XML_ESCAPE(formatDate(end))} · stored locally for dependable loading</text>
  ${monthLabels.join("")}
  ${cells.join("")}
  <text x="36" y="300" fill="#57606a" font-family="${fontFamily()}" font-size="11">Less</text>
  ${legend}
  <text x="1063" y="288" fill="#57606a" font-family="${fontFamily()}" font-size="11">More</text>
</svg>
`
}

async function main() {
  const {profile, contributions} = await loadProfile()
  const {collection, end} = contributions
  await mkdir(OUTPUT_DIRECTORY, {recursive: true})
  const assets = {
    "github-activity-light.svg": renderActivity({profile, collection, end}),
    "contribution-grid-light.svg": renderContributionGrid({collection, end}),
  }
  await Promise.all(Object.entries(assets).map(([name, contents]) => writeFile(resolve(OUTPUT_DIRECTORY, name), contents)))
  console.log(JSON.stringify({
    profile: PROFILE_LOGIN,
    totalContributions: collection.contributionCalendar.totalContributions,
    publicRepositories: profile.public_repos,
    updated: end.toISOString(),
    files: Object.keys(assets),
  }))
}

await main()

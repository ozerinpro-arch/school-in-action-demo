import { expect, test, type Locator, type Page } from '@playwright/test'

const configuredPort = process.env.DEMO_PORT || '5261'
if (!/^\d{1,5}$/.test(configuredPort) || Number(configuredPort) < 1 || Number(configuredPort) > 65535) {
  throw new Error('DEMO_PORT must be a valid loopback port.')
}
const origin = `http://127.0.0.1:${Number(configuredPort)}`
const ownerPath = '/client/school/'
const staffPath = '/school-staff/'
const syntheticPassword = 'SchoolDemo-2026-Local!'

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue()
    : route.abort('blockedbyclient'))
  await context.routeWebSocket('**/*', socket => socket.close())
})

async function ownerSection(page: Page, section: string) {
  await page.goto(`${origin}${ownerPath}#${section}`)
  const main = page.locator(`#school-main[data-page="${section}"]`)
  await expect(main).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', /^en(?:-|$)/i)
  return main
}

async function enterStudent(page: Page) {
  await page.goto(`${origin}${staffPath}`)
  await page.locator('input[autocomplete="username"]').fill('demo.student')
  await page.locator('input[autocomplete="current-password"]').fill(syntheticPassword)
  await page.locator('form button[type="submit"]').click()
  const main = page.locator('#student-main')
  await expect(main).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', /^en(?:-|$)/i)
  return main
}

async function downloadPdf(page: Page, trigger: Locator) {
  const [response, download] = await Promise.all([
    page.waitForResponse(result => new URL(result.url()).pathname.endsWith('/receipt.pdf')),
    page.waitForEvent('download'),
    trigger.click(),
  ])
  expect(response.ok()).toBeTruthy()
  expect(response.headers()['content-type']).toContain('application/pdf')
  expect((await response.body()).subarray(0, 5).toString()).toBe('%PDF-')
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i)
  expect(await download.failure()).toBeNull()
  return response.url()
}

test('loads the original director timetable, checks and weekly solver', async ({ page }) => {
  await ownerSection(page, 'overview')
  for (const section of ['schedule', 'replacements', 'publications', 'school-calendar', 'clubs', 'analytics']) {
    await expect(page.locator(`.sg-navigation a[href="#${section}"]`)).toHaveCount(1)
  }
  await page.locator('.sg-navigation a[href="#schedule"]').click()
  const timetable = page.locator('#school-main[data-page="schedule"]')
  await expect(timetable.getByTestId('timetable-lesson').first()).toBeVisible()
  const defaultDialog = page.locator('dialog.tt-sheet[open]')
  if (await defaultDialog.count()) await page.keyboard.press('Escape')
  await timetable.locator('.tt-class-filter select').selectOption('7A')
  const lesson = timetable.getByTestId('timetable-lesson').first()
  await expect(lesson).toContainText('Mathematics')
  await lesson.click()
  await expect(page.locator('dialog[open] .tt-editor')).toBeVisible()
  await page.keyboard.press('Escape')
  await timetable.locator('.tt-signal-summary').click()
  await expect(page.locator('dialog[open] .tt-checks')).toBeVisible()
  await page.keyboard.press('Escape')
  await timetable.locator('.tt-school-actions > button:nth-of-type(2)').click()
  await expect(page.locator('dialog[open]').getByTestId('scheduling-planner')).toBeVisible()
})

test('checks a dated substitution against the original published timetable', async ({ page }) => {
  const main = await ownerSection(page, 'replacements')
  const form = main.locator('.school-replacements form.sg-settings-form').first()
  const date = form.locator('input[type="date"]')
  await expect(date).toBeEnabled()
  const firstDate = await date.getAttribute('min')
  if (!firstDate) throw new Error('The fictional fixture did not publish a dated timetable.')
  await date.fill(firstDate)
  await form.locator('select').nth(0).selectOption('demo-math-1')
  await form.locator('select').nth(1).selectOption('Owen Reed')
  await form.locator('textarea').fill('Coverage for a fictional training day.')
  const [preview] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/school/replacements/preview')),
    form.locator('button[type="submit"]').click(),
  ])
  expect(preview.ok()).toBeTruthy()
  expect((await preview.json()).ready).toBe(true)
  const changes = main.locator('.sr-change-grid').first()
  await expect(changes).toContainText('Maya Brooks')
  await expect(changes).toContainText('Owen Reed')
})

test('downloads the confirmed fictional club receipt as director and student', async ({ page }) => {
  const clubs = await ownerSection(page, 'clubs')
  await clubs.locator('.sc-tabs [role="tab"]').nth(2).click()
  const clubCharge = clubs.locator('.sc-list .sc-row').filter({ hasText: 'Robotics club' }).filter({ hasText: 'Jamie Lane' }).first()
  const directorReceipt = await downloadPdf(page, clubCharge.getByRole('button', { name: 'Download PDF', exact: true }))

  const student = await enterStudent(page)
  const receipts = student.getByRole('region', { name: 'Club receipts', exact: true })
  await receipts.getByRole('button', { name: 'Show receipts', exact: true }).click()
  const receipt = receipts.getByRole('listitem').filter({ hasText: 'Robotics club' }).first()
  const studentReceipt = await downloadPdf(page, receipt.getByRole('button', { name: 'Download PDF', exact: true }))
  expect(new URL(directorReceipt).pathname).toMatch(/^\/client\/school\/api\//)
  expect(new URL(studentReceipt).pathname).toMatch(/^\/school-staff\/api\/student\//)
  expect(new URL(studentReceipt).pathname.split('/').at(-2)).toBe(new URL(directorReceipt).pathname.split('/').at(-2))
})

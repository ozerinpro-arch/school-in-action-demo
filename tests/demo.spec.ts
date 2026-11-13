import { expect, test, type Page } from '@playwright/test'

const roles = {
  director: 'Director',
  maya: 'Teacher · Maya Brooks',
  owen: 'Teacher · Owen Reed',
  jamie: 'Student · Jamie Lane',
}

function card(page: Page, text: string | RegExp) {
  return page.getByRole('article').filter({ hasText: text })
}

function navigationItem(page: Page, name: string) {
  const navigation = page.getByRole('navigation')
  return navigation.getByRole('link').filter({ has: page.getByText(name, { exact: true }) })
}

async function open(page: Page, section: string) {
  await navigationItem(page, section).click()
  await expect(page.getByRole('main').getByRole('heading', { name: section, exact: true })).toBeVisible()
}

async function useRole(page: Page, role: keyof typeof roles) {
  const selector = page.getByRole('combobox', { name: 'Demo role', exact: true })
  await selector.selectOption({ label: roles[role] })
  await expect(selector.locator('option:checked')).toHaveText(roles[role])
}

async function enterDemo(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('main').getByRole('heading', { name: 'Schedule', exact: true })).toBeVisible()
}

test.beforeAll(async ({ browser, baseURL }) => {
  if (process.env.DEMO_E2E_RESET !== '1') return
  const page = await browser.newPage({ baseURL })
  try {
    await enterDemo(page)
    const reset = await page.request.post('/api/demo/reset', { data: {} })
    expect(reset.ok(), `Demo reset returned HTTP ${reset.status()}`).toBeTruthy()
  } finally {
    await page.close()
  }
})

test('edits the weekly timetable, filters by day and rejects overlapping lessons', async ({ page }) => {
  await enterDemo(page)
  await page.getByRole('combobox', { name: 'Day filter', exact: true }).selectOption('Thursday')
  const main = page.getByRole('main')
  await expect(main).toContainText('No lessons match this view.')

  const topic = `Practical genetics ${Date.now()}`
  await page.getByRole('button', { name: 'Add lesson', exact: true }).click()
  await page.getByRole('combobox', { name: 'Day', exact: true }).selectOption('Thursday')
  await page.getByRole('combobox', { name: 'Class', exact: true }).selectOption('Grade 7A')
  await page.getByLabel('Start time', { exact: true }).fill('09:00')
  await page.getByLabel('End time', { exact: true }).fill('09:45')
  await page.getByRole('combobox', { name: 'Teacher', exact: true }).selectOption({ label: 'Maya Brooks · Biology' })
  await page.getByLabel('Room', { exact: true }).fill('Lab 1')
  await page.getByLabel('Lesson topic', { exact: true }).fill(topic)
  await page.getByRole('button', { name: 'Save lesson', exact: true }).click()
  const lesson = card(page, topic)
  await expect(lesson).toContainText('Lab 1')

  await lesson.getByRole('button', { name: 'Edit lesson', exact: true }).click()
  await lesson.getByLabel('Room', { exact: true }).fill('Lab 4')
  await lesson.getByRole('button', { name: 'Save lesson', exact: true }).click()
  await expect(lesson).toContainText('Lab 4')

  await lesson.getByRole('button', { name: 'Edit lesson', exact: true }).click()
  await lesson.getByRole('combobox', { name: 'Day', exact: true }).selectOption('Monday')
  await lesson.getByRole('button', { name: 'Save lesson', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(/overlap|already|busy/i)
  await lesson.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(lesson).toContainText('Lab 4')
})

test('approves a substitution and updates both the substitute and student schedules', async ({ page }) => {
  await enterDemo(page)
  await useRole(page, 'maya')

  const biology = () => card(page, 'Cell structure')
  const request = biology().getByRole('button', { name: 'Request substitution', exact: true })
  await request.click()
  const reason = `Curriculum workshop ${Date.now()}`
  await biology().getByLabel('Reason', { exact: true }).fill(reason)
  await biology().getByRole('button', { name: 'Send request', exact: true }).click()

  await useRole(page, 'director')
  await open(page, 'Substitutions')
  const substitution = card(page, reason)
  const candidate = substitution.getByRole('combobox', { name: 'Substitute teacher', exact: true })
  await candidate.selectOption({ value: await candidate.getByRole('option', { name: /Owen Reed/ }).getAttribute('value') ?? '' })
  await substitution.getByRole('button', { name: 'Approve substitution', exact: true }).click()
  await expect(substitution).toContainText(/approved/i)

  await useRole(page, 'owen')
  await open(page, 'Schedule')
  await expect(biology()).toContainText('Owen Reed')
  await expect(biology()).toContainText('Lab 2')
  await expect(biology().getByRole('button', { name: 'Mark lesson complete', exact: true })).toBeEnabled()

  await useRole(page, 'jamie')
  await open(page, 'Schedule')
  await expect(biology()).toContainText('Owen Reed')
  await expect(biology()).toContainText(/substitut/i)
  await expect(biology().getByRole('button', { name: 'Mark lesson complete', exact: true })).toHaveCount(0)

  await useRole(page, 'owen')
  await open(page, 'Schedule')
  await biology().getByRole('button', { name: 'Mark lesson complete', exact: true }).click()
  await expect(biology()).toContainText(/completed/i)
})

test('publishes an assignment, accepts a student answer and returns teacher feedback', async ({ page }) => {
  await enterDemo(page)
  await useRole(page, 'jamie')
  await open(page, 'Grades')
  await expect(page.getByRole('main')).toContainText('No grades yet.')
  await useRole(page, 'maya')
  await open(page, 'Assignments')

  const title = `Plant life cycle ${Date.now()}`
  await page.getByText('New assignment', { exact: true }).click()
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Instructions', { exact: true }).fill('Explain how seeds disperse.')
  await page.getByRole('combobox', { name: 'Student', exact: true }).selectOption({ label: 'Jamie Lane' })
  await page.getByRole('combobox', { name: 'Subject', exact: true }).selectOption({ label: 'Biology' })
  await page.getByLabel('Due date', { exact: true }).fill('2026-11-20')
  await page.getByRole('button', { name: 'Publish assignment', exact: true }).click()
  await expect(card(page, title)).toBeVisible()

  await useRole(page, 'jamie')
  await open(page, 'Assignments')
  const assignment = card(page, title)
  const answer = 'Seeds can travel by wind, water, or animals.'
  await assignment.getByLabel('Your answer', { exact: true }).fill(answer)
  await assignment.getByRole('button', { name: 'Submit answer', exact: true }).click()
  await expect(assignment).toContainText(/submitted/i)

  await useRole(page, 'maya')
  await open(page, 'Assignments')
  await expect(assignment).toContainText(answer)
  await assignment.getByLabel('Score (0–100)', { exact: true }).fill('93')
  const feedback = 'Clear explanation with three examples.'
  await assignment.getByLabel('Feedback', { exact: true }).fill(feedback)
  await assignment.getByRole('button', { name: 'Save review', exact: true }).click()
  await expect(assignment).toContainText(/reviewed/i)

  await useRole(page, 'jamie')
  await open(page, 'Assignments')
  await expect(assignment).toContainText(feedback)
  await expect(assignment).toContainText('93')
  await expect(assignment.getByRole('button', { name: 'Save review', exact: true })).toHaveCount(0)

  await open(page, 'Grades')
  await expect(card(page, 'Average assignment score')).toContainText('93/100')
  await expect(assignment).toContainText('93/100')
  await expect(assignment).toContainText(feedback)

  await open(page, 'Progress')
  await expect(card(page, 'Reviewed')).toContainText('1')
  const biology = page.getByRole('progressbar', { name: 'Biology assignments submitted' })
  await expect(biology).toHaveAttribute('value', '1')
  await expect(biology).toHaveAttribute('max', '2')
})

test('opens a club, shows the roster to the director and lets the student withdraw', async ({ page }) => {
  await enterDemo(page)
  await open(page, 'Clubs')

  const name = `Field Sketching ${Date.now()}`
  const newClub = page.locator('details').filter({ has: page.getByText('New club', { exact: true }) })
  await newClub.getByText('New club', { exact: true }).click()
  await newClub.getByLabel('Club name', { exact: true }).fill(name)
  await newClub.getByLabel('Description', { exact: true }).fill('Observe plants and sketch them in the courtyard.')
  await newClub.getByLabel('Meeting time', { exact: true }).fill('Thursday at 15:30')
  await newClub.getByLabel('Capacity', { exact: true }).fill('8')
  await newClub.getByLabel('Demo fee (USD)', { exact: true }).fill('12.50')
  await newClub.getByRole('button', { name: 'Create club', exact: true }).click()
  const club = card(page, name)
  await expect(club).toBeVisible()

  await useRole(page, 'jamie')
  await open(page, 'Clubs')
  await club.getByRole('button', { name: 'Join club', exact: true }).click()
  await expect(club.getByRole('button', { name: 'Leave club', exact: true })).toBeVisible()

  await useRole(page, 'director')
  await open(page, 'Clubs')
  await expect(club.getByRole('listitem').filter({ hasText: 'Jamie Lane' })).toBeVisible()

  const fees = page.getByRole('region', { name: 'Demo fees', exact: true })
  await fees.getByRole('combobox', { name: 'Enrollment', exact: true }).selectOption({ label: `${name} · Jamie Lane` })
  await fees.getByLabel('Billing month', { exact: true }).fill('2026-11')
  await fees.getByRole('button', { name: 'Preview fee', exact: true }).click()
  await expect(fees.getByRole('status')).toHaveText('Estimated fee $12.50')
  await fees.getByRole('button', { name: 'Save fee draft', exact: true }).click()
  const charge = fees.getByRole('listitem').filter({ hasText: name })
  await expect(charge).toContainText('Draft')
  await open(page, 'Receipts')
  await expect(card(page, name)).toHaveCount(0)
  await open(page, 'Clubs')
  await charge.getByRole('button', { name: 'Confirm fee', exact: true }).click()
  await expect(charge).toContainText('Confirmed')
  await open(page, 'Receipts')
  const newReceipt = card(page, name).getByRole('link', { name: 'Download receipt (PDF)', exact: true })
  const receiptPath = await newReceipt.getAttribute('href')
  if (!receiptPath) throw new Error('The confirmed fee has no receipt URL.')
  expect(receiptPath).toMatch(/^\/api\/clubs\/receipts\/[^/]+\/pdf$/)

  await useRole(page, 'jamie')
  await open(page, 'Receipts')
  await expect(newReceipt).toHaveAttribute('href', receiptPath)
  await open(page, 'Clubs')
  await expect(charge).toContainText('$12.50')
  await expect(charge).toContainText('Confirmed')
  await club.getByRole('button', { name: 'Leave club', exact: true }).click()
  await expect(club.getByRole('button', { name: 'Join club', exact: true })).toBeVisible()

  await useRole(page, 'director')
  await open(page, 'Clubs')
  await expect(club.getByRole('listitem').filter({ hasText: 'Jamie Lane' })).toHaveCount(0)
  await charge.getByRole('button', { name: 'Cancel fee', exact: true }).click()
  await expect(charge).toContainText('Cancelled')
  await open(page, 'Receipts')
  await expect(card(page, name)).toHaveCount(0)
  expect((await page.request.get(receiptPath)).status()).toBe(404)
  await open(page, 'Clubs')
  await club.getByRole('button', { name: 'Archive club', exact: true }).click()
  await expect(club).toContainText('Archived')

  await useRole(page, 'jamie')
  await open(page, 'Clubs')
  await expect(club).toHaveCount(0)
  await useRole(page, 'director')
  await open(page, 'Clubs')
  await club.getByRole('button', { name: 'Restore club', exact: true }).click()
  await expect(club.getByRole('button', { name: 'Archive club', exact: true })).toBeVisible()
})

test('downloads the fictional receipt and keeps other student receipts private', async ({ page }) => {
  await enterDemo(page)
  await open(page, 'Receipts')
  const seedPath = '/api/clubs/receipts/demo-robotics-receipt/pdf'
  const example = card(page, 'Robotics club').filter({ hasText: 'Jamie Lane' })
  const seedLink = example.getByRole('link', { name: 'Download receipt (PDF)', exact: true })
  await expect(seedLink).toHaveAttribute('href', seedPath)
  await expect(example).toContainText('$12.50')
  const [download] = await Promise.all([page.waitForEvent('download'), seedLink.click()])
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i)
  expect(await download.failure()).toBeNull()
  const pdf = await page.request.get(seedPath)
  expect(pdf.ok()).toBeTruthy()
  expect(pdf.headers()['content-type']).toContain('application/pdf')
  expect(pdf.headers()['content-disposition']).toMatch(/^attachment\b/i)
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-')

  await open(page, 'Clubs')
  const robotics = card(page, 'Robotics club')
  await robotics.getByRole('combobox', { name: 'Student', exact: true }).selectOption({ label: 'Riley Bell · Grade 7B' })
  await robotics.getByRole('button', { name: 'Add member', exact: true }).click()
  const fees = page.getByRole('region', { name: 'Demo fees', exact: true })
  await fees.getByRole('combobox', { name: 'Enrollment', exact: true }).selectOption({ label: 'Robotics club · Riley Bell' })
  await fees.getByLabel('Billing month', { exact: true }).fill('2026-11')
  await fees.getByRole('button', { name: 'Preview fee', exact: true }).click()
  await fees.getByRole('button', { name: 'Save fee draft', exact: true }).click()
  await fees.getByRole('listitem').filter({ hasText: 'Riley Bell' }).getByRole('button', { name: 'Confirm fee', exact: true }).click()

  await open(page, 'Receipts')
  const rileyLink = card(page, 'Robotics club').filter({ hasText: 'Riley Bell' })
    .getByRole('link', { name: 'Download receipt (PDF)', exact: true })
  const rileyPath = await rileyLink.getAttribute('href')
  if (!rileyPath) throw new Error('Riley’s confirmed fee has no receipt URL.')
  expect(rileyPath).toMatch(/^\/api\/clubs\/receipts\/[^/]+\/pdf$/)
  expect(rileyPath).not.toBe(seedPath)

  await useRole(page, 'jamie')
  await open(page, 'Receipts')
  await expect(page.getByRole('main')).not.toContainText('Riley Bell')
  await expect(page.getByRole('link', { name: 'Download receipt (PDF)', exact: true })).toHaveCount(1)
  expect((await page.request.get(seedPath)).ok()).toBeTruthy()
  expect((await page.request.get(rileyPath)).status()).toBe(404)

  await useRole(page, 'maya')
  await expect(navigationItem(page, 'Receipts')).toHaveCount(0)
  expect((await page.request.get(seedPath)).status()).toBe(403)
})

test('shares lesson material, manages staff tasks and reviews director records', async ({ page }) => {
  await enterDemo(page)
  await useRole(page, 'maya')
  await open(page, 'Materials')
  const material = `Food web field notes ${Date.now()}`
  await page.getByText('Share lesson material', { exact: true }).click()
  await page.getByRole('combobox', { name: 'Lesson', exact: true }).selectOption({ label: 'Wednesday · Grade 7A · Food webs' })
  await page.getByLabel('Material title', { exact: true }).fill(material)
  await page.getByLabel('Material text', { exact: true }).fill('Compare producers and consumers in the school garden.')
  await page.getByRole('button', { name: 'Share material', exact: true }).click()
  await expect(card(page, material)).toBeVisible()

  await open(page, 'School tasks')
  const task = `Prepare identification cards ${Date.now()}`
  await page.getByText('New school task', { exact: true }).click()
  await page.getByLabel('Task title', { exact: true }).fill(task)
  await page.getByLabel('Description', { exact: true }).fill('Print a class set for the garden visit.')
  await page.getByRole('button', { name: 'Create task', exact: true }).click()
  const taskStatus = card(page, task).getByRole('combobox', { name: 'Task status', exact: true })
  await taskStatus.selectOption('done')
  await expect(taskStatus).toHaveValue('done')

  await useRole(page, 'jamie')
  await expect(navigationItem(page, 'School tasks')).toHaveCount(0)
  await expect(navigationItem(page, 'Documents')).toHaveCount(0)
  await open(page, 'Materials')
  await expect(card(page, material)).toContainText('Compare producers and consumers')
  await open(page, 'Activity')
  const notification = card(page, `Lesson material shared · ${material}`)
  await expect(notification).toContainText('New')
  await page.getByRole('button', { name: 'Mark all as read', exact: true }).click()
  await expect(notification.getByText('New', { exact: true })).toHaveCount(0)

  await useRole(page, 'director')
  await open(page, 'Documents')
  const document = card(page, 'Lab safety checklist')
  await document.getByRole('button', { name: 'Approve document', exact: true }).click()
  await expect(document).toContainText('Approved')
  await open(page, 'Directory')
  const main = page.getByRole('main')
  await expect(main).toContainText('Maya Brooks')
  await expect(main).toContainText('Jamie Lane')
  await open(page, 'Overview')
  await expect(card(page, 'Scheduled lessons')).toBeVisible()
  await expect(main.getByRole('progressbar', { name: 'reviewed assignments' })).toBeVisible()
})

test('labels external integrations and supports mobile keyboard navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await enterDemo(page)
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  const main = page.getByRole('main')
  await expect(main).not.toContainText(/[А-Яа-яЁё]/)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  await page.keyboard.press('Tab')
  await expect(page.locator(':focus-visible')).toBeVisible()
  const guide = main.getByText('What can I try?', { exact: true })
  await guide.focus()
  await guide.press('Enter')
  await expect(main.getByText('Cover a lesson.', { exact: true })).toBeVisible()
  await main.getByRole('link', { name: 'Receipts', exact: true }).click()
  await expect(main.getByRole('heading', { name: 'Receipts', exact: true })).toBeVisible()
  await useRole(page, 'maya')
  await expect(page).toHaveURL(/#schedule$/)
  await page.goto('/#receipts')
  await expect(page).toHaveURL(/#schedule$/)
  await useRole(page, 'director')
  const integrations = navigationItem(page, 'Integrations')
  await integrations.focus()
  await expect(integrations).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(main.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible()
  for (const label of ['AI assistance', 'MAX notifications', 'School identity and data imports', 'Payment processing', 'School planning and publication']) {
    await expect(main.getByText(label, { exact: true })).toBeVisible()
  }
  await expect(main).toContainText(/disabled|unavailable|not connected/i)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('recovers from a failed initial data request', async ({ page }) => {
  const state = '**/api/state'
  await page.route(state, route => route.abort(), { times: 1 })
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('Could not connect to the demo.')
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('main').getByRole('heading', { name: 'Schedule', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

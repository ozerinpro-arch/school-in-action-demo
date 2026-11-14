import dictionarySource from './english-dictionary.json?raw'

type Dictionary = { text: Record<string, string>; patterns: Record<string, string> }
const dictionary: Dictionary = JSON.parse(dictionarySource)
const cyrillic = /[А-Яа-яЁё]/
const fields = /QZX(\d+)XZQ/g
const trimSpaces = (text: string) => text.replace(/\s+/g, ' ').trim()
const exact = new Map(Object.entries(dictionary.text).map(([text, result]) => [trimSpaces(text), result]))
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const dynamic = Object.entries(dictionary.patterns).flatMap(([pattern, result]) => {
  const parts = trimSpaces(pattern).split(fields)
  const fixed = parts.filter((_, index) => index % 2 === 0).join('')
  if (fixed.length < 7 || !cyrillic.test(fixed)) return []
  const regex = parts.map((part, index) => index % 2 === 0 ? escapePattern(part) : '(.+?)').join('')
  return [{ regex: new RegExp('^' + regex + '$'), slots: parts.filter((_, index) => index % 2 === 1), result, length: fixed.length }]
}).sort((first, second) => second.length - first.length)

const suffix = /^(.+?)([.!?…:;,·]+)$/
const months: Record<string, string> = {
  января: 'January', февраля: 'February', марта: 'March', апреля: 'April', мая: 'May', июня: 'June',
  июля: 'July', августа: 'August', сентября: 'September', октября: 'October', ноября: 'November', декабря: 'December',
}

function translate(text: string, depth = 0): string {
  if (!cyrillic.test(text) || depth > 2) return text
  const normalized = trimSpaces(text)
  const known = exact.get(normalized)
  if (known !== undefined) return known

  for (const { regex, slots, result } of dynamic) {
    const match = regex.exec(normalized)
    if (!match) continue
    const values = new Map(slots.map((slot, index) => [slot, translate(match[index + 1], depth + 1)]))
    const translated = result.replace(fields, (original, slot: string) => values.get(slot) ?? original)
    if (!cyrillic.test(translated)) return translated
  }

  const labeled = /^(В архив|Поиск|Закрыть):? (.+)$/.exec(normalized)
  if (labeled) {
    const label = exact.get(labeled[1] + ':')
    const value = translate(labeled[2], depth + 1)
    if (label && !cyrillic.test(value)) return label + ' ' + value
  }
  const count = /^(\d+) (занятие|занятия|занятий|строка|строки|строк)$/.exec(normalized)
  if (count) {
    const unit = count[2].startsWith('строк') ? 'row' : 'lesson'
    return count[1] + ' ' + unit + (count[1] === '1' ? '' : 's')
  }
  const localizedZone = normalized.replace(/ мск\.?$/u, ' Moscow time')
  if (!cyrillic.test(localizedZone)) return localizedZone

  const trailing = suffix.exec(normalized)
  if (trailing && exact.has(trailing[1])) return exact.get(trailing[1]) + trailing[2]

  const joined = normalized.split(/(\s[·•—–]\s|\n|,\s+)/)
  if (joined.length > 1) {
    const translated = joined.map(part => translate(part, depth + 1)).join('')
    if (!cyrillic.test(translated)) return translated
  }

  const date = normalized.replace(/\b(\d{1,2})\s+([а-яё]+)(?=\s|$)/gi, (phrase, day: string, month: string) => months[month.toLowerCase()] ? months[month.toLowerCase()] + ' ' + day : phrase)
  if (!cyrillic.test(date)) return date
  return text
}

const attributes = ['aria-label', 'aria-description', 'aria-valuetext', 'alt', 'placeholder', 'title']
const excluded = 'script,style,textarea,[contenteditable="true"]'
const preservedOptions = new WeakSet<HTMLOptionElement>()

function translateText(node: Text) {
  const parent = node.parentElement
  const original = node.data
  if (!parent || parent.closest(excluded) || !cyrillic.test(original)) return
  const leading = original.match(/^\s*/)?.[0] ?? ''
  const trailing = original.match(/\s*$/)?.[0] ?? ''
  const translated = leading + translate(original.trim()) + trailing
  if (translated === original) return
  if (parent instanceof HTMLOptionElement && (!parent.hasAttribute('value') || preservedOptions.has(parent))) {
    // Some original selects use their labels as values. Keep the value passed to the app.
    const selected = parent.selected
    parent.value = original.trim()
    preservedOptions.add(parent)
    node.data = translated
    if (selected) parent.selected = true
    return
  }
  node.data = translated
}

function translateAttributes(element: Element) {
  for (const attribute of attributes) {
    const original = element.getAttribute(attribute)
    if (original && cyrillic.test(original)) {
      const translated = translate(original)
      if (original !== translated) element.setAttribute(attribute, translated)
    }
  }
}

function translateTree(node: Node) {
  if (node instanceof Text) {
    translateText(node)
    return
  }
  if (!(node instanceof Element)) return
  translateAttributes(node)
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let item = walker.nextNode(); item; item = walker.nextNode()) {
    if (item instanceof Text) translateText(item)
    else if (item instanceof Element) translateAttributes(item)
  }
}

const root = document.getElementById('root')
if (root) {
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData' && record.target instanceof Text) translateText(record.target)
      else if (record.type === 'attributes' && record.target instanceof Element) translateAttributes(record.target)
      else record.addedNodes.forEach(translateTree)
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes })
  translateTree(root)
}

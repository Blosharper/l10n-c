interface LocalesData {
  [lang: string]: Record<string, string>
}

let localesData: LocalesData = {}
let languages: string[] = []
let allKeys: string[] = []
let filteredKeys: string[] = []
let categories: string[] = []
let visibleLanguages: string[] = []
let selectedCategories: string[] = []
let selectedLanguages: string[] = []
let changes: Record<string, Record<string, string>> = {}

const tableHead = document.getElementById('table-head')!
const tableBody = document.getElementById('table-body')!
const btnPublish = document.getElementById('btn-publish') as HTMLButtonElement
const btnDownloadCsv = document.getElementById(
  'btn-download-csv',
) as HTMLButtonElement
const searchInput = document.getElementById('search') as HTMLInputElement

const categoryAnchor = document.getElementById('category-anchor')!
const categoryItems = document.getElementById('category-items')!
const categoryDropdown = document.getElementById('category-dropdown')!

const languageAnchor = document.getElementById('language-anchor')!
const languageItems = document.getElementById('language-items')!
const languageDropdown = document.getElementById('language-dropdown')!

const scrollSentinel = document.getElementById('scroll-sentinel')!
const tableContainer = document.getElementById('table-container')!
const progressBar = document.getElementById('progress-bar')!

let scrollObserver: IntersectionObserver

let visibilityObserver: IntersectionObserver

async function init() {
  try {
    const res = await fetch('/i18n/api/locales')
    if (!res.ok) throw new Error('Failed to fetch locales')
    localesData = await res.json()

    const configResponse = await fetch('/i18n/api/config')
    if (!configResponse.ok)
      throw new Error('Failed to fetch editor configuration')
    const { languageOrder: predefinedOrder } =
      (await configResponse.json()) as { languageOrder: string[] }
    const availableLangs = Object.keys(localesData)
    languages = predefinedOrder.filter((l) => availableLangs.includes(l))
    languages.push(
      ...availableLangs.filter((l) => !predefinedOrder.includes(l)),
    )

    const keySet = new Set<string>()
    const catSet = new Set<string>()
    for (const lang of languages) {
      for (const key of Object.keys(localesData[lang])) {
        if (!key.startsWith('_meta')) {
          keySet.add(key)
          if (key.includes('.')) {
            const cat = key.split('.')[0]
            if (cat !== '_meta') {
              catSet.add(cat)
            }
          }
        }
      }
    }
    allKeys = Array.from(keySet).sort()
    categories = Array.from(catSet).sort()

    const urlParams = new URLSearchParams(window.location.search)
    if (urlParams.has('search')) searchInput.value = urlParams.get('search')!
    selectedCategories = urlParams.has('category')
      ? urlParams.get('category')!.split(',')
      : []
    selectedCategories.sort(
      (a, b) => categories.indexOf(a) - categories.indexOf(b),
    )
    selectedLanguages = urlParams.has('language')
      ? urlParams
          .get('language')!
          .split(',')
          .filter((l) => languages.includes(l))
      : []
    selectedLanguages.sort(
      (a, b) => languages.indexOf(a) - languages.indexOf(b),
    )

    categories.forEach((cat) => {
      const li = document.createElement('li')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.value = cat
      cb.checked = selectedCategories.includes(cat)
      cb.addEventListener('change', () => {
        if (cb.checked) {
          selectedCategories.push(cat)
          selectedCategories.sort(
            (a, b) => categories.indexOf(a) - categories.indexOf(b),
          )
        } else selectedCategories = selectedCategories.filter((c) => c !== cat)
        updateDropdownAnchor(categoryAnchor, selectedCategories, 'Categories')
        applyFilters()
      })
      li.appendChild(cb)
      const count = allKeys.filter(
        (key) => key === cat || key.startsWith(cat + '.'),
      ).length
      li.appendChild(document.createTextNode(` ${cat} (${count})`))
      categoryItems.appendChild(li)
    })
    updateDropdownAnchor(categoryAnchor, selectedCategories, 'Categories')

    languages.forEach((l) => {
      const li = document.createElement('li')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.value = l
      cb.checked = selectedLanguages.includes(l)
      cb.addEventListener('change', () => {
        if (cb.checked) {
          selectedLanguages.push(l)
          selectedLanguages.sort(
            (a, b) => languages.indexOf(a) - languages.indexOf(b),
          )
        } else selectedLanguages = selectedLanguages.filter((x) => x !== l)
        updateDropdownAnchor(languageAnchor, selectedLanguages, 'Languages')
        applyFilters()
      })
      li.appendChild(cb)
      li.appendChild(document.createTextNode(` ${l.toUpperCase()}`))
      languageItems.appendChild(li)
    })
    updateDropdownAnchor(languageAnchor, selectedLanguages, 'Languages')

    setupDropdown(categoryDropdown, categoryAnchor)
    setupDropdown(languageDropdown, languageAnchor)

    languages.forEach((l) => (changes[l] = {}))

    setupObservers()
    applyFilters()

    setTimeout(() => {
      const savedScroll = localStorage.getItem('i18nScrollTop')
      if (savedScroll) {
        tableContainer.scrollTop = parseInt(savedScroll, 10)
      }
    }, 100)
  } catch (err: any) {
    console.error(err)
    alert(`Failed to load locales: ${err.message}`)
  }
}

function setupObservers() {
  visibilityObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const tr = entry.target as HTMLTableRowElement
        if (entry.isIntersecting) {
          fillRow(tr)
        } else {
          if (!tr.querySelector('.editing')) {
            clearRow(tr)
          }
        }
      })
    },
    {
      root: tableContainer,
      rootMargin: '200px',
    },
  )
}

function applyFilters() {
  const filterText = searchInput.value.toLowerCase()

  visibleLanguages =
    selectedLanguages.length > 0 ? selectedLanguages : languages

  const url = new URL(window.location.href)
  if (filterText) url.searchParams.set('search', filterText)
  else url.searchParams.delete('search')

  if (selectedCategories.length > 0)
    url.searchParams.set('category', selectedCategories.join(','))
  else url.searchParams.delete('category')

  if (selectedLanguages.length > 0)
    url.searchParams.set('language', selectedLanguages.join(','))
  else url.searchParams.delete('language')

  window.history.replaceState({}, '', url)

  const prevScrollTop = tableContainer.scrollTop

  filteredKeys = allKeys.filter((key) => {
    if (selectedCategories.length > 0) {
      const matchCat = selectedCategories.some(
        (cat) => key === cat || key.startsWith(cat + '.'),
      )
      if (!matchCat) return false
    }

    let match = key.toLowerCase().includes(filterText)
    if (!match) {
      for (const lang of visibleLanguages) {
        const rawVal = localesData[lang][key]
        const val =
          rawVal === null || rawVal === undefined ? '' : String(rawVal)
        if (val.toLowerCase().includes(filterText)) {
          match = true
          break
        }
      }
    }
    return match
  })

  tableHead.innerHTML = `<th class="key-col">Key (${filteredKeys.length})</th>`
  const counts = visibleLanguages.map((lang) => {
    return filteredKeys.filter((key) => {
      return (
        localesData[lang][key] !== undefined || changes[lang][key] !== undefined
      )
    }).length
  })
  const maxCount = Math.max(...counts)

  visibleLanguages.forEach((lang, idx) => {
    const count = counts[idx]
    const cls = count !== maxCount ? ' class="warning"' : ''
    tableHead.innerHTML += `<th${cls}>${lang.toUpperCase()} (${count})</th>`
  })

  renderVirtualTable()

  setTimeout(() => {
    tableContainer.scrollTop = prevScrollTop
  }, 0)
}

function renderVirtualTable() {
  visibilityObserver.disconnect()
  tableBody.innerHTML = ''

  const fragment = document.createDocumentFragment()

  for (let i = 0; i < filteredKeys.length; i++) {
    const tr = document.createElement('tr')
    tr.className = 'virtual-row'
    tr.dataset.index = String(i)

    visibilityObserver.observe(tr)
    fragment.appendChild(tr)
  }

  tableBody.appendChild(fragment)
  updateProgressBar()
}

function clearRow(tr: HTMLTableRowElement) {
  tr.innerHTML = ''
}

function fillRow(tr: HTMLTableRowElement) {
  if (tr.childElementCount > 0) return

  const index = parseInt(tr.dataset.index || '0', 10)
  const key = filteredKeys[index]
  if (!key) return

  const fragment = document.createDocumentFragment()

  // Key Column
  const tdKey = document.createElement('td')
  tdKey.className = 'key-label'
  tdKey.textContent = key
  tdKey.title = key
  fragment.appendChild(tdKey)

  // Value Columns
  visibleLanguages.forEach((lang) => {
    const td = document.createElement('td')
    td.className = 'editable-cell'

    const rawVal = localesData[lang][key]
    const val = rawVal === null || rawVal === undefined ? '' : String(rawVal)
    const isMissing = !val.trim()

    if (isMissing) td.classList.add('missing')

    let changedVal = changes[lang][key]
    let displayVal = changedVal !== undefined ? changedVal : val

    if (changedVal !== undefined) {
      td.classList.add('changed')
      td.classList.remove('missing')
    }

    const contentDiv = document.createElement('div')
    contentDiv.className = 'cell-content'
    contentDiv.textContent = displayVal || (isMissing ? '(Empty)' : '')
    td.appendChild(contentDiv)

    td.addEventListener('click', () => {
      if (td.classList.contains('editing')) return
      td.classList.add('editing')

      changedVal = changes[lang][key]
      const currentValue = localesData[lang][key]
      displayVal =
        changedVal !== undefined ? changedVal : String(currentValue ?? '')

      const textarea = document.createElement('textarea')
      textarea.value = displayVal
      textarea.placeholder = isMissing ? '(Empty)' : ''

      contentDiv.style.visibility = 'hidden'
      td.appendChild(textarea)

      textarea.focus()
      textarea.style.height = 'auto'
      textarea.style.height = textarea.scrollHeight + 'px'

      textarea.addEventListener('input', function () {
        this.style.height = 'auto'
        this.style.height = this.scrollHeight + 'px'
      })

      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          textarea.blur()
        }
      })

      textarea.addEventListener('blur', () => {
        const newVal = textarea.value
        handleInput(lang, key, newVal, td)

        contentDiv.textContent = newVal || (!newVal.trim() ? '(Empty)' : '')
        contentDiv.style.visibility = 'visible'
        textarea.remove()
        td.classList.remove('editing')
      })
    })

    fragment.appendChild(td)
  })

  tr.appendChild(fragment)
}

function updateProgressBar() {
  const scrollHeight = tableContainer.scrollHeight
  const clientHeight = tableContainer.clientHeight
  const scrollTop = tableContainer.scrollTop

  const maxScroll = scrollHeight - clientHeight
  if (maxScroll <= 0) {
    progressBar.style.width = '0%'
    progressBar.style.left = '0%'
    return
  }

  const widthPercent = (clientHeight / scrollHeight) * 100

  const leftPercent = (scrollTop / scrollHeight) * 100

  progressBar.style.width = `${Math.min(widthPercent, 100)}%`
  progressBar.style.left = `${Math.min(leftPercent, 100)}%`
}

tableContainer.addEventListener('scroll', () => {
  updateProgressBar()

  localStorage.setItem('i18nScrollTop', tableContainer.scrollTop.toString())
})
window.addEventListener('resize', updateProgressBar)

function handleInput(
  lang: string,
  key: string,
  value: string,
  tdElement: HTMLElement,
) {
  const rawOriginal = localesData[lang][key]
  const original =
    rawOriginal === null || rawOriginal === undefined ? '' : String(rawOriginal)

  if (value !== original) {
    changes[lang][key] = value
    tdElement.classList.add('changed')
    if (value.trim()) tdElement.classList.remove('missing')
  } else {
    delete changes[lang][key]
    tdElement.classList.remove('changed')
    if (!value.trim()) tdElement.classList.add('missing')
  }

  updatePublishButton()
}

function updatePublishButton() {
  let count = 0
  languages.forEach((lang) => {
    count += Object.keys(changes[lang]).length
  })

  btnPublish.textContent = `🚀 Publish (${count})`
  btnPublish.disabled = count === 0
}

btnPublish.addEventListener('click', async () => {
  try {
    btnPublish.disabled = true
    btnPublish.textContent = '🚀 Publishing...'

    const res = await fetch('/i18n/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes }),
    })

    if (!res.ok) throw new Error('Publish failed')

    btnPublish.textContent = '🚀 Saved successfully!'

    languages.forEach((lang) => {
      Object.assign(localesData[lang], changes[lang])
      changes[lang] = {}
    })

    document
      .querySelectorAll('.changed')
      .forEach((el) => el.classList.remove('changed'))

    setTimeout(() => {
      updatePublishButton()
    }, 2000)
  } catch (err: any) {
    console.error(err)
    alert(`Error: ${err.message}`)
    updatePublishButton()
  }
})

function downloadCSV() {
  let csvContent = '\uFEFF'

  // Header
  const headers = ['Key', ...visibleLanguages.map((l) => l.toUpperCase())]
  csvContent += headers.map(escapeCSV).join(',') + '\n'

  for (const key of filteredKeys) {
    const row = [key]
    for (const lang of visibleLanguages) {
      let val =
        changes[lang][key] !== undefined
          ? changes[lang][key]
          : localesData[lang][key]

      val = val === null || val === undefined ? '' : String(val)
      row.push(escapeCSV(val))
    }
    csvContent += row.join(',') + '\n'
  }

  // Download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const dateStr = new Date().toISOString().split('T')[0]
  a.href = url
  a.download = `l10n-c_${dateStr}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function escapeCSV(str: string): string {
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

btnDownloadCsv.addEventListener('click', downloadCSV)
searchInput.addEventListener('input', () => {
  applyFilters()
})
function setupDropdown(dropdown: HTMLElement, anchor: HTMLElement) {
  anchor.addEventListener('click', (e) => {
    dropdown.classList.toggle('visible')
    e.stopPropagation()
  })
}

document.addEventListener('click', (e) => {
  if (!categoryDropdown.contains(e.target as Node))
    categoryDropdown.classList.remove('visible')
  if (!languageDropdown.contains(e.target as Node))
    languageDropdown.classList.remove('visible')
})

function updateDropdownAnchor(
  anchor: HTMLElement,
  selected: string[],
  typeName: string,
) {
  if (selected.length === 0) {
    anchor.textContent = `All ${typeName}`
  } else {
    anchor.textContent = selected.join(', ')
  }
}

init()

export {}

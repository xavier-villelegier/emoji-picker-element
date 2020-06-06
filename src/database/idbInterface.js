import { dbPromise, get } from './databaseLifecycle'
import {
  INDEX_GROUP_AND_ORDER, INDEX_TOKENS, KEY_ETAG, KEY_URL,
  MODE_READONLY, MODE_READWRITE,
  STORE_EMOJI,
  STORE_META
} from './constants'
import { transformEmojiBaseData } from './transformEmojiBaseData'
import { mark, stop } from '../shared/marks'
import { extractTokens } from './utils/extractTokens'

export async function isEmpty (db) {
  return !(await get(db, STORE_META, KEY_URL))
}

export async function hasData (db, url, eTag) {
  const [oldETag, oldUrl] = await get(db, STORE_META, [KEY_ETAG, KEY_URL])
  return (oldETag === eTag && oldUrl === url)
}

export async function loadData (db, emojiBaseData, url, eTag) {
  mark('loadData')
  try {
    const transformedData = transformEmojiBaseData(emojiBaseData)
    const [oldETag, oldUrl] = await get(db, STORE_META, [KEY_ETAG, KEY_URL])
    if (oldETag === eTag && oldUrl === url) {
      return
    }
    await dbPromise(db, [STORE_EMOJI, STORE_META], MODE_READWRITE, ([emojiStore, metaStore]) => {
      let oldETag
      let oldUrl
      let oldKeys
      let todo = 0

      function checkFetched () {
        if (++todo === 3) {
          onFetched()
        }
      }

      function onFetched () {
        if (oldETag === eTag && oldUrl === url) {
          // check again within the transaction to guard against concurrency, e.g. multiple browser tabs
          return
        }
        if (oldKeys.length) {
          for (const key of oldKeys) {
            emojiStore.delete(key)
          }
        }
        insertData()
      }

      function insertData () {
        for (const data of transformedData) {
          emojiStore.put(data)
        }
        metaStore.put(eTag, KEY_ETAG)
        metaStore.put(url, KEY_URL)
      }

      metaStore.get(KEY_ETAG).onsuccess = e => {
        oldETag = e.target.result
        checkFetched()
      }

      metaStore.get(KEY_URL).onsuccess = e => {
        oldUrl = e.target.result
        checkFetched()
      }

      emojiStore.getAllKeys().onsuccess = e => {
        oldKeys = e.target.result
        checkFetched()
      }
    })
  } finally {
    stop('loadData')
  }
}

export async function getEmojiByGroup (db, group) {
  return dbPromise(db, STORE_EMOJI, MODE_READONLY, (emojiStore, cb) => {
    const range = IDBKeyRange.bound([group, 0], [group + 1, 0], false, true)
    emojiStore.index(INDEX_GROUP_AND_ORDER).getAll(range).onsuccess = e => {
      cb(e.target.result)
    }
  })
}

export async function getEmojiBySearchQuery (db, query) {
  const tokens = extractTokens(query)
  return dbPromise(db, STORE_EMOJI, MODE_READONLY, (emojiStore, cb) => {
    // get all results that contain all tokens (i.e. an AND query)
    const intermediateResults = []

    const checkDone = () => {
      if (intermediateResults.length === tokens.length) {
        onDone()
      }
    }

    const onDone = () => {
      const results = []
      const shortestArray = intermediateResults.sort((a, b) => (a.length < b.length ? -1 : 1))[0]
      for (const item of shortestArray) {
        // if this item is included in every array in the intermediate results, add it to the final results
        if (!intermediateResults.some(array => array.findIndex(_ => _.unicode === item.unicode) === -1)) {
          results.push(item)
        }
      }
      cb(results.sort((a, b) => a.order < b.order ? -1 : 1))
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      const range = i === tokens.length - 1
        ? IDBKeyRange.bound(token, token + '\uffff', false, true) // treat last token as a prefix search
        : IDBKeyRange.only(token) // treat all other tokens as an exact match
      emojiStore.index(INDEX_TOKENS).getAll(range).onsuccess = e => {
        intermediateResults.push(e.target.result)
        checkDone()
      }
    }
  })
}

export async function getEmojiByShortcode (db, shortcode) {
  shortcode = shortcode.toLowerCase()
  return dbPromise(db, STORE_EMOJI, MODE_READONLY, (emojiStore, cb) => {
    const range = IDBKeyRange.only(shortcode)
    emojiStore.index(INDEX_TOKENS).getAll(range).onsuccess = e => {
      // of course, we could add an extra index just for shortcodes, but it seems
      // simpler to just re-use the existing tokens index and filter in-memory
      const results = e.target.result.filter(emoji => emoji.shortcodes.includes(shortcode))
      cb(results[0])
    }
  })
}

export async function getEmojiByUnicode (db, unicode) {
  return dbPromise(db, STORE_EMOJI, MODE_READONLY, (emojiStore, cb) => {
    emojiStore.get(unicode).onsuccess = e => cb(e.target.result)
  })
}

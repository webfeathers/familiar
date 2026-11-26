import assert from 'node:assert/strict'
import test from 'node:test'
import { isOwnerEmail, parseEmailList } from '../src/owner.ts'

test('owner email list accepts addresses, bare domains and @domains', () => {
  assert.deepEqual(parseEmailList(' Me@Example.com, example.org ,@Corp.io,, '), [
    'me@example.com',
    'example.org',
    'corp.io',
  ])
  assert.deepEqual(parseEmailList(undefined), [])
})

test('owner email matching: exact address, or a domain and its subdomains', () => {
  const owned = parseEmailList('me@example.com, corp.io')
  assert.ok(isOwnerEmail('ME@example.com', owned))
  assert.ok(!isOwnerEmail('you@example.com', owned))
  assert.ok(isOwnerEmail('anyone@corp.io', owned))
  assert.ok(isOwnerEmail('anyone@mail.corp.io', owned))
  assert.ok(!isOwnerEmail('anyone@notcorp.io', owned))
  assert.ok(!isOwnerEmail('anyone@corp.io.evil.com', owned))
  assert.ok(!isOwnerEmail('me@example.com', []))
})

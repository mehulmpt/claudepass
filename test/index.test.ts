import { describe, expect, it } from 'vite-plus/test'
import {
	checkEmail,
	expandIPv6,
	ipKey,
	oddsOneIn,
	parseLadder,
	randomToken,
	maskEmail,
} from '../src/lib.ts'

describe('ipKey', () => {
	it('keeps IPv4 as-is', () => {
		expect(ipKey('203.0.113.7')).toBe('v4:203.0.113.7')
	})
	it("collapses IPv6 to /64 so rotating the host bits doesn't help", () => {
		const a = ipKey('2001:db8:abcd:12:1::1')
		const b = ipKey('2001:0db8:abcd:0012:ffff:eeee:dddd:cccc')
		expect(a).toBe('v6:2001:0db8:abcd:0012::/64')
		expect(b).toBe(a)
		expect(ipKey('2001:db8:abcd:13::1')).not.toBe(a)
	})
	it('treats IPv4-mapped IPv6 as IPv4', () => {
		expect(ipKey('::ffff:203.0.113.7')).toBe('v4:203.0.113.7')
		expect(ipKey('::ffff:cb00:7107')).toBe('v4:203.0.113.7')
	})
	it('rejects junk', () => {
		for (const bad of [
			'',
			'1.2.3',
			'256.1.1.1',
			'01.2.3.4',
			'1::2::3',
			'gggg::1',
			'1:2:3:4:5:6:7:8:9',
		]) {
			expect(ipKey(bad)).toBeNull()
		}
		expect(expandIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
	})
})

describe('checkEmail', () => {
	it('canonicalises gmail dots and plus tags', () => {
		const r = checkEmail(' Jane.Doe+promo@GoogleMail.com ')
		expect(r).toEqual({
			ok: true,
			address: 'Jane.Doe+promo@GoogleMail.com',
			canonical: 'janedoe@gmail.com',
		})
	})
	it('strips plus tags on other domains but keeps dots', () => {
		expect(checkEmail('a.b+x@example.com')).toMatchObject({
			ok: true,
			canonical: 'a.b@example.com',
		})
	})
	it('rejects invalid addresses', () => {
		expect(checkEmail('nope').ok).toBe(false)
		expect(checkEmail('a@b').ok).toBe(false)
		expect(checkEmail('+@example.com').ok).toBe(false)
	})
})

it('claim tokens are 256-bit base64url', () => {
	const t = randomToken()
	expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
	expect(randomToken()).not.toBe(t)
})

describe('odds ladder', () => {
	const ladder = parseLadder('10000, 20000,100000')
	it('gets harder with each pass taken', () => {
		expect([0, 1, 2].map((taken) => oddsOneIn({ ladder, taken }))).toEqual([
			10000, 20000, 100000,
		])
	})
	it('clamps past the ends', () => {
		expect(oddsOneIn({ ladder, taken: 7 })).toBe(100000)
		expect(oddsOneIn({ ladder, taken: -1 })).toBe(10000)
	})
	it('rejects bad config', () => {
		expect(() => parseLadder('0.05')).toThrow()
		expect(() => parseLadder('10,abc')).toThrow()
	})
})

describe('maskEmail', () => {
	it('masks the back half of the local part and keeps common domains', () => {
		expect(maskEmail('mehulmohan@gmail.com')).toBe('mehul•••••@gmail.com')
		expect(maskEmail('Ab@Proton.me')).toBe('a•@proton.me')
		expect(maskEmail('x@outlook.com')).toBe('•@outlook.com')
	})
	it('masks uncommon domains down to the TLD', () => {
		expect(maskEmail('jane.doe@acme.io')).toBe('jane••••@••••.io')
		expect(maskEmail('a@mail.company.co.uk')).toBe('•@••••••••.uk')
	})
})

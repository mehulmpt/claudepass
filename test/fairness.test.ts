// Runs inside workerd (the Workers runtime), so this exercises the same
// crypto.getRandomValues that production uses. Bounds are ~6 standard deviations
// wide, so a correct generator essentially never fails them.
import { describe, expect, it } from 'vite-plus/test'
import { rollWin, secureRandom } from '../src/lib.ts'

const wins = ({ oneIn, draws }: { oneIn: number; draws: number }) => {
	let n = 0
	for (let i = 0; i < draws; i++) if (rollWin(oneIn)) n++
	return n
}

describe('fairness of the draw on workerd', () => {
	it('secureRandom is uniform on [0, 1)', () => {
		const buckets = 20
		const draws = 1_000_000
		const counts = new Array<number>(buckets).fill(0)
		for (let i = 0; i < draws; i++) {
			const r = secureRandom()
			expect(r >= 0 && r < 1).toBe(true)
			counts[Math.floor(r * buckets)]++
		}
		const expected = draws / buckets
		const chi2 = counts.reduce(
			(sum, c) => sum + (c - expected) ** 2 / expected,
			0,
		)
		// 19 degrees of freedom: a fair generator lands above 60 about once in a million runs.
		expect(chi2).toBeLessThan(60)
	}, 60_000)

	it('wins at 1 in 10,000 as often as it should', () => {
		// expect 200 wins, standard deviation ~14
		const n = wins({ oneIn: 10_000, draws: 2_000_000 })
		expect(n).toBeGreaterThan(115)
		expect(n).toBeLessThan(285)
	}, 60_000)

	it('wins at 1 in 100 as often as it should', () => {
		// expect 10,000 wins, standard deviation ~99
		const n = wins({ oneIn: 100, draws: 1_000_000 })
		expect(n).toBeGreaterThan(9_400)
		expect(n).toBeLessThan(10_600)
	}, 60_000)

	it('never wins at impossible odds and always wins at certain odds', () => {
		expect(wins({ oneIn: 1, draws: 10_000 })).toBe(10_000)
		expect(wins({ oneIn: Number.POSITIVE_INFINITY, draws: 10_000 })).toBe(0)
	})
})

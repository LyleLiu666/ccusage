function safeTimeZone(timezone?: string): string {
	if (timezone == null || timezone.trim() === '') {
		return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
	}

	try {
		// Validate timezone by creating a formatter
		Intl.DateTimeFormat('en-US', { timeZone: timezone });
		return timezone;
	} catch {
		return 'UTC';
	}
}

export function toDateKey(timestamp: string, timezone?: string): string {
	const tz = safeTimeZone(timezone);
	const date = new Date(timestamp);
	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: tz,
	});
	return formatter.format(date);
}

export function normalizeFilterDate(value?: string): string | undefined {
	if (value == null) {
		return undefined;
	}

	const compact = value.replaceAll('-', '').trim();
	if (!/^\d{8}$/.test(compact)) {
		throw new Error(`Invalid date format: ${value}. Expected YYYYMMDD or YYYY-MM-DD.`);
	}

	return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

export function isWithinRange(dateKey: string, since?: string, until?: string): boolean {
	const value = dateKey.replaceAll('-', '');
	const sinceValue = since?.replaceAll('-', '');
	const untilValue = until?.replaceAll('-', '');

	if (sinceValue != null && value < sinceValue) {
		return false;
	}

	if (untilValue != null && value > untilValue) {
		return false;
	}

	return true;
}

export function toFilterStartTimestamp(dateKey: string, timezone?: string): number {
	const tz = safeTimeZone(timezone);
	const [yearStr = '0', monthStr = '1', dayStr = '1'] = dateKey.split('-');
	const year = Number.parseInt(yearStr, 10);
	const month = Number.parseInt(monthStr, 10);
	const day = Number.parseInt(dayStr, 10);

	let low = Date.UTC(year, month - 1, day) - 36 * 60 * 60 * 1000;
	let high = Date.UTC(year, month - 1, day) + 36 * 60 * 60 * 1000;

	while (low < high) {
		const mid = low + Math.floor((high - low) / 2);
		const currentDateKey = toDateKey(new Date(mid).toISOString(), tz);
		if (currentDateKey < dateKey) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}

	return low;
}

export function formatDisplayDate(dateKey: string, locale?: string, _timezone?: string): string {
	// dateKey is already computed for the target timezone via toDateKey().
	// Treat it as a plain calendar date and avoid shifting it by applying a timezone.
	const [yearStr = '0', monthStr = '1', dayStr = '1'] = dateKey.split('-');
	const year = Number.parseInt(yearStr, 10);
	const month = Number.parseInt(monthStr, 10);
	const day = Number.parseInt(dayStr, 10);
	const date = new Date(Date.UTC(year, month - 1, day));
	const formatter = new Intl.DateTimeFormat(locale ?? 'en-US', {
		year: 'numeric',
		month: 'short',
		day: '2-digit',
		timeZone: 'UTC',
	});
	return formatter.format(date);
}

export function toMonthKey(timestamp: string, timezone?: string): string {
	const tz = safeTimeZone(timezone);
	const date = new Date(timestamp);
	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		timeZone: tz,
	});
	const [year, month] = formatter.format(date).split('-');
	return `${year}-${month}`;
}

export function formatDisplayMonth(monthKey: string, locale?: string, _timezone?: string): string {
	// monthKey is already derived in the target timezone via toMonthKey().
	// Render it as a calendar month without shifting by timezone.
	const [yearStr = '0', monthStr = '1'] = monthKey.split('-');
	const year = Number.parseInt(yearStr, 10);
	const month = Number.parseInt(monthStr, 10);
	const date = new Date(Date.UTC(year, month - 1, 1));
	const formatter = new Intl.DateTimeFormat(locale ?? 'en-US', {
		year: 'numeric',
		month: 'short',
		timeZone: 'UTC',
	});
	return formatter.format(date);
}

export function formatDisplayDateTime(
	timestamp: string,
	locale?: string,
	timezone?: string,
): string {
	const tz = safeTimeZone(timezone);
	const date = new Date(timestamp);
	const formatter = new Intl.DateTimeFormat(locale ?? 'en-US', {
		dateStyle: 'short',
		timeStyle: 'short',
		timeZone: tz,
	});
	return formatter.format(date);
}

if (import.meta.vitest != null) {
	describe('toFilterStartTimestamp', () => {
		it('returns the UTC timestamp for the start of the local day', () => {
			const timestamp = toFilterStartTimestamp('2025-09-11', 'Asia/Shanghai');
			expect(new Date(timestamp).toISOString()).toBe('2025-09-10T16:00:00.000Z');
		});

		it('finds the first instant of a day across DST boundaries', () => {
			const timestamp = toFilterStartTimestamp('2025-11-02', 'America/New_York');
			expect(toDateKey(new Date(timestamp).toISOString(), 'America/New_York')).toBe('2025-11-02');
			expect(toDateKey(new Date(timestamp - 1).toISOString(), 'America/New_York')).toBe(
				'2025-11-01',
			);
		});
	});
}

import type { Args, ArgSchema, Command } from 'gunshi';
import process from 'node:process';
import { cli, parseArgs } from 'gunshi';
import { description, name, version } from '../package.json';
import { dailyCommand } from './commands/daily.ts';
import { monthlyCommand } from './commands/monthly.ts';
import { recentCommand } from './commands/recent.ts';
import { sessionCommand } from './commands/session.ts';
import { logger } from './logger.ts';

const subCommands = new Map<string, Command>([
	['daily', dailyCommand],
	['monthly', monthlyCommand],
	['recent', recentCommand],
	['session', sessionCommand],
]);

const mainCommand = dailyCommand;
const commonArgs = {
	help: {
		type: 'boolean',
		short: 'h',
		description: 'Display this help message',
	},
	version: {
		type: 'boolean',
		short: 'v',
		description: 'Display this version',
	},
} as const satisfies Args;
const cliOptions = {
	name,
	version,
	description,
	subCommands,
	renderHeader: null,
};

type ParsedArgToken = ReturnType<typeof parseArgs>[number];

type UnsupportedCliArgument = {
	message: string;
	helpArgs: string[];
};

function toKebabCase(value: string): string {
	return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function getOptionName(name: string, schema: ArgSchema, command: Command): string {
	if (schema.toKebab === true || command.toKebab === true) {
		return toKebabCase(name);
	}

	return name;
}

function getCommandArgs(command: Command): Args {
	return {
		...(command.args ?? {}),
		...commonArgs,
	};
}

function buildOptionMaps(command: Command): {
	longOptions: Map<string, ArgSchema>;
	shortOptions: Map<string, ArgSchema>;
} {
	const longOptions = new Map<string, ArgSchema>();
	const shortOptions = new Map<string, ArgSchema>();

	for (const [name, schema] of Object.entries(getCommandArgs(command))) {
		const optionName = getOptionName(name, schema, command);
		longOptions.set(optionName, schema);
		if (schema.type === 'boolean' && schema.negatable === true) {
			longOptions.set(`no-${optionName}`, schema);
		}
		if (schema.short != null) {
			shortOptions.set(schema.short, schema);
		}
	}

	return { longOptions, shortOptions };
}

function getOptionSchema(
	token: ParsedArgToken,
	longOptions: Map<string, ArgSchema>,
	shortOptions: Map<string, ArgSchema>,
): ArgSchema | undefined {
	if (token.kind !== 'option' || token.name == null || token.rawName == null) {
		return undefined;
	}

	if (token.rawName.startsWith('--')) {
		return longOptions.get(token.name);
	}

	return shortOptions.get(token.name);
}

function optionConsumesFollowingValue(schema: ArgSchema, token: ParsedArgToken): boolean {
	return schema.type !== 'boolean' && token.inlineValue !== true;
}

function optionHasValue(
	schema: ArgSchema,
	token: ParsedArgToken,
	tokens: ParsedArgToken[],
): boolean {
	if (schema.type === 'boolean') {
		return true;
	}

	if (token.inlineValue === true) {
		return token.value != null;
	}

	return tokens.some((candidate) => {
		return candidate.kind === 'positional' && candidate.index === token.index + 1;
	});
}

function findUnsupportedCliArgument(argv: string[]): UnsupportedCliArgument | undefined {
	const tokens = parseArgs(argv);
	const firstToken = tokens[0];
	let command: Command = mainCommand;
	let commandName: string | undefined;
	const allowedPositionalIndexes = new Set<number>();

	if (firstToken?.kind === 'positional' && firstToken.index === 0) {
		const value = firstToken.value ?? '';
		const subCommand = subCommands.get(value);
		if (subCommand == null) {
			return {
				message: `Unknown command: ${value}`,
				helpArgs: ['--help'],
			};
		}

		command = subCommand;
		commandName = value;
		allowedPositionalIndexes.add(firstToken.index);
	}

	const { longOptions, shortOptions } = buildOptionMaps(command);
	const optionValueIndexes = new Set<number>();

	for (const token of tokens) {
		if (token.kind !== 'option') {
			continue;
		}

		const schema = getOptionSchema(token, longOptions, shortOptions);
		if (schema == null) {
			return {
				message: `Unknown option: ${token.rawName ?? token.name ?? ''}`,
				helpArgs: commandName == null ? ['--help'] : [commandName, '--help'],
			};
		}

		if (!optionHasValue(schema, token, tokens)) {
			return {
				message: `Missing value for option: ${token.rawName ?? token.name ?? ''}`,
				helpArgs: commandName == null ? ['--help'] : [commandName, '--help'],
			};
		}

		if (optionConsumesFollowingValue(schema, token)) {
			optionValueIndexes.add(token.index + 1);
		}
	}

	for (const token of tokens) {
		if (token.kind === 'option-terminator') {
			return {
				message: 'Unexpected argument: --',
				helpArgs: commandName == null ? ['--help'] : [commandName, '--help'],
			};
		}

		if (token.kind !== 'positional') {
			continue;
		}

		if (allowedPositionalIndexes.has(token.index) || optionValueIndexes.has(token.index)) {
			continue;
		}

		return {
			message: `Unexpected argument: ${token.value ?? ''}`,
			helpArgs: commandName == null ? ['--help'] : [commandName, '--help'],
		};
	}

	return undefined;
}

export async function run(): Promise<void> {
	// When invoked through npx, the binary name might be passed as the first argument
	// Filter it out if it matches the expected binary name
	let args = process.argv.slice(2);
	if (args[0] === 'ccusage-codex') {
		args = args.slice(1);
	}

	const unsupportedArgument = findUnsupportedCliArgument(args);
	if (unsupportedArgument != null) {
		logger.error(unsupportedArgument.message);
		await cli(unsupportedArgument.helpArgs, mainCommand, cliOptions);
		process.exit(1);
	}

	await cli(args, mainCommand, cliOptions);
}

if (import.meta.vitest != null) {
	describe('findUnsupportedCliArgument', () => {
		it('rejects unknown options on the entry command', () => {
			expect(findUnsupportedCliArgument(['--no-such-arg'])).toEqual({
				message: 'Unknown option: --no-such-arg',
				helpArgs: ['--help'],
			});
		});

		it('rejects unknown options on subcommands with subcommand help', () => {
			expect(findUnsupportedCliArgument(['monthly', '--no-such-arg'])).toEqual({
				message: 'Unknown option: --no-such-arg',
				helpArgs: ['monthly', '--help'],
			});
		});

		it('rejects unknown commands with entry help', () => {
			expect(findUnsupportedCliArgument(['weekly'])).toEqual({
				message: 'Unknown command: weekly',
				helpArgs: ['--help'],
			});
		});

		it('allows option values without treating them as unexpected positionals', () => {
			expect(findUnsupportedCliArgument(['monthly', '--since', '2026-06-01'])).toBeUndefined();
		});

		it('allows inline option values', () => {
			expect(findUnsupportedCliArgument(['monthly', '--since=2026-06-01'])).toBeUndefined();
		});

		it('rejects options that require a value when the value is missing', () => {
			expect(findUnsupportedCliArgument(['monthly', '--since'])).toEqual({
				message: 'Missing value for option: --since',
				helpArgs: ['monthly', '--help'],
			});
		});

		it('allows grouped short options that are valid for the selected command', () => {
			expect(findUnsupportedCliArgument(['-wb'])).toBeUndefined();
		});

		it('allows kebab-case no-color option from the help text', () => {
			expect(findUnsupportedCliArgument(['-w', '--no-color'])).toBeUndefined();
		});

		it('rejects short options that are not valid for the selected command', () => {
			expect(findUnsupportedCliArgument(['monthly', '-w'])).toEqual({
				message: 'Unknown option: -w',
				helpArgs: ['monthly', '--help'],
			});
		});

		it('allows recent command options', () => {
			expect(
				findUnsupportedCliArgument(['recent', '--hours', '12', '--interval', '60', '--all']),
			).toBeUndefined();
		});
	});
}

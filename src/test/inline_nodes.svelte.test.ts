import { describe, expect, it } from 'vitest';
import create_test_session from './create_test_session.js';
import {
	validate_document_schema,
	validate_document,
	validate_config_components
} from '../lib/doc_utils.js';
import { INLINE_NODE_PLACEHOLDER } from '../lib/utils.js';
import InlineChip from './testing_components/InlineChip.svelte';

const description_path = ['story_1', 'description'];

/**
 * A session whose story description accepts a `strong` mark and a `mention`
 * inline node. The shared schema and config objects are cloned so per-test
 * mutations cannot leak into other suites.
 */
export function create_inline_session() {
	const session = create_test_session();
	session.schema = structuredClone(session.schema);
	session.config = {
		...session.config,
		node_components: { ...session.config.node_components }
	};
	session.schema.strong = { kind: 'mark', properties: {} };
	session.schema.mention = { kind: 'inline', properties: { user_id: { type: 'string' } } };
	(session.schema.story.properties.description as any).mark_types = ['strong'];
	(session.schema.story.properties.description as any).inline_types = ['mention'];
	session.config.node_components.mention = InlineChip;
	return session;
}

/** A document node graph carrying one mention in the story description. */
function doc_with_mention(start_offset: number, end_offset: number) {
	return {
		document_id: 'page_1',
		nodes: {
			mention_1: { id: 'mention_1', type: 'mention', user_id: 'johannes' },
			story_1: {
				id: 'story_1',
				type: 'story',
				layout: 'image-left',
				image: '',
				title: { content: 'First story', marks: [], annotations: [] },
				buttons: { nodes: [], marks: [], annotations: [] },
				description: {
					content: `Hi ${INLINE_NODE_PLACEHOLDER} there`,
					marks: [{ start_offset, end_offset, node_id: 'mention_1' }],
					annotations: []
				}
			},
			page_1: {
				id: 'page_1',
				type: 'page',
				body: { nodes: ['story_1'], marks: [], annotations: [] },
				keywords: [],
				daily_visitors: [],
				created_at: '2026-08-22T00:00:00.000Z'
			}
		}
	};
}

describe('inline node schema validation', () => {
	it('exposes a single-character placeholder', () => {
		expect(INLINE_NODE_PLACEHOLDER).toBe('￼');
		expect(INLINE_NODE_PLACEHOLDER.length).toBe(1);
	});

	it('accepts inline_types referencing a node type of kind inline', () => {
		const session = create_inline_session();
		expect(() => validate_document_schema(session.schema)).not.toThrow();
	});

	it('rejects inline_types referencing a type that is not of kind inline', () => {
		const session = create_inline_session();
		(session.schema.story.properties.description as any).inline_types = ['strong'];
		expect(() => validate_document_schema(session.schema)).toThrow(/kind 'inline'/);
	});

	it('rejects inline_types on a node_array property', () => {
		const session = create_inline_session();
		(session.schema.page.properties.body as any).inline_types = ['mention'];
		expect(() => validate_document_schema(session.schema)).toThrow(/only supported in text/);
	});

	it('accepts a mention spanning exactly one character', () => {
		const session = create_inline_session();
		expect(() => validate_document(doc_with_mention(3, 4) as any, session.schema)).not.toThrow();
	});

	it('rejects a mention spanning more than one character', () => {
		const session = create_inline_session();
		expect(() => validate_document(doc_with_mention(3, 5) as any, session.schema)).toThrow(
			/exactly one character/
		);
	});

	it('rejects an inline node type with no registered component', () => {
		const session = create_inline_session();
		delete session.config.node_components.mention;
		// Session's constructor calls this; calling it directly keeps the test
		// independent of the constructor's argument order.
		expect(() => validate_config_components(session.schema, session.config)).toThrow(
			/must have a registered component/
		);
	});
});

describe('insert_inline_node', () => {
	function select(session: any, anchor_offset: number, focus_offset: number) {
		session.selection = {
			type: 'text',
			path: description_path,
			anchor_offset,
			focus_offset
		};
	}

	it('inserts a placeholder, a one-character mark and leaves the caret after it', () => {
		const session = create_inline_session();
		select(session, 5, 5);
		session.apply(session.tr.insert_inline_node('mention', { user_id: 'johannes' }));

		const value = session.get(description_path);
		expect(value.content.slice(5, 6)).toBe(INLINE_NODE_PLACEHOLDER);
		expect(value.marks).toHaveLength(1);
		expect(value.marks[0].start_offset).toBe(5);
		expect(value.marks[0].end_offset).toBe(6);
		expect(session.get(value.marks[0].node_id).user_id).toBe('johannes');
		expect(session.selection).toMatchObject({ anchor_offset: 6, focus_offset: 6 });
	});

	it('replaces a non-collapsed selection', () => {
		const session = create_inline_session();
		const original = session.get(description_path).content;
		select(session, 0, 5);
		session.apply(session.tr.insert_inline_node('mention', { user_id: 'johannes' }));

		const value = session.get(description_path);
		expect(value.content).toBe(INLINE_NODE_PLACEHOLDER + original.slice(5));
		expect(value.marks[0]).toMatchObject({ start_offset: 0, end_offset: 1 });
	});

	it('refuses an inline type that is not declared on the property', () => {
		const session = create_inline_session();
		select(session, 5, 5);
		session.apply(session.tr.insert_inline_node('ticker', { symbol: 'AAPL' }));
		expect(session.get(description_path).marks).toHaveLength(0);
	});

	it('refuses to insert inside an existing mark', () => {
		const session = create_inline_session();
		select(session, 0, 10);
		session.apply(session.tr.toggle_mark('strong'));
		select(session, 5, 5);
		session.apply(session.tr.insert_inline_node('mention', { user_id: 'johannes' }));

		const value = session.get(description_path);
		expect(value.marks).toHaveLength(1);
		expect(session.get(value.marks[0].node_id).type).toBe('strong');
	});

	it('keeps the attachment on the right character when typing around it', () => {
		const session = create_inline_session();
		select(session, 5, 5);
		session.apply(session.tr.insert_inline_node('mention', { user_id: 'johannes' }));

		// Typing before it shifts the attachment along.
		select(session, 0, 0);
		session.apply(session.tr.insert_text('ab'));
		expect(session.get(description_path).marks[0]).toMatchObject({
			start_offset: 7,
			end_offset: 8
		});

		// Typing at its trailing edge stays outside it.
		select(session, 8, 8);
		session.apply(session.tr.insert_text('cd'));
		expect(session.get(description_path).marks[0]).toMatchObject({
			start_offset: 7,
			end_offset: 8
		});
	});

	it('deletes the payload node when its character is deleted', () => {
		const session = create_inline_session();
		select(session, 5, 5);
		session.apply(session.tr.insert_inline_node('mention', { user_id: 'johannes' }));
		const mention_id = session.get(description_path).marks[0].node_id;

		select(session, 6, 6);
		session.apply(session.tr.delete_selection('backward'));

		expect(session.get(description_path).marks).toHaveLength(0);
		expect(session.get(mention_id)).toBeUndefined();
	});

	it('reports available inline types for the current selection', () => {
		const session = create_inline_session();
		select(session, 5, 5);
		expect(session.available_inline_types).toEqual(['mention']);
		session.selection = {
			type: 'text',
			path: ['story_1', 'title'],
			anchor_offset: 0,
			focus_offset: 0
		};
		expect(session.available_inline_types).toEqual([]);
	});
});

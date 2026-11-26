# Product scope

Codex Chats List is a native VS Code sidebar tree for developers working across several repositories. Its purpose is to find existing Codex conversations by working directory and return to the official Codex view with one click.

The scope is project grouping, current/all-project selection, title search, pagination, and navigation. It does not implement chat, full transcript viewing, custom tags, manual categories, archiving, or deletion. It does not patch the official extension.

The local official Codex app-server provides metadata. The official extension owns the conversation editor, execution, authentication, and conversation persistence. Opening a conversation depends on the official extension's editor resource format and stays in the initiating VS Code window.

Primary interactions stay visible. Grouping derives from existing directory metadata. The UI follows VS Code themes and explicitly represents empty, loading, failure, and pagination states. Unverified platform support must remain documented.

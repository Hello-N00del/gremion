// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invitation_recipient_page.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$InvitationRecipientPage extends InvitationRecipientPage {
  @override
  final BuiltList<InvitationRecipient> items;
  @override
  final String? nextCursor;

  factory _$InvitationRecipientPage(
          [void Function(InvitationRecipientPageBuilder)? updates]) =>
      (InvitationRecipientPageBuilder()..update(updates))._build();

  _$InvitationRecipientPage._({required this.items, this.nextCursor})
      : super._();
  @override
  InvitationRecipientPage rebuild(
          void Function(InvitationRecipientPageBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  InvitationRecipientPageBuilder toBuilder() =>
      InvitationRecipientPageBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is InvitationRecipientPage &&
        items == other.items &&
        nextCursor == other.nextCursor;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, items.hashCode);
    _$hash = $jc(_$hash, nextCursor.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'InvitationRecipientPage')
          ..add('items', items)
          ..add('nextCursor', nextCursor))
        .toString();
  }
}

class InvitationRecipientPageBuilder
    implements
        Builder<InvitationRecipientPage, InvitationRecipientPageBuilder> {
  _$InvitationRecipientPage? _$v;

  ListBuilder<InvitationRecipient>? _items;
  ListBuilder<InvitationRecipient> get items =>
      _$this._items ??= ListBuilder<InvitationRecipient>();
  set items(ListBuilder<InvitationRecipient>? items) => _$this._items = items;

  String? _nextCursor;
  String? get nextCursor => _$this._nextCursor;
  set nextCursor(String? nextCursor) => _$this._nextCursor = nextCursor;

  InvitationRecipientPageBuilder() {
    InvitationRecipientPage._defaults(this);
  }

  InvitationRecipientPageBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _items = $v.items.toBuilder();
      _nextCursor = $v.nextCursor;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(InvitationRecipientPage other) {
    _$v = other as _$InvitationRecipientPage;
  }

  @override
  void update(void Function(InvitationRecipientPageBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  InvitationRecipientPage build() => _build();

  _$InvitationRecipientPage _build() {
    _$InvitationRecipientPage _$result;
    try {
      _$result = _$v ??
          _$InvitationRecipientPage._(
            items: items.build(),
            nextCursor: nextCursor,
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'items';
        items.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'InvitationRecipientPage', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint

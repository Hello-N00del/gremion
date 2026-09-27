// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invitation_page.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$InvitationPage extends InvitationPage {
  @override
  final BuiltList<Invitation> items;
  @override
  final String? nextCursor;

  factory _$InvitationPage([void Function(InvitationPageBuilder)? updates]) =>
      (InvitationPageBuilder()..update(updates))._build();

  _$InvitationPage._({required this.items, this.nextCursor}) : super._();
  @override
  InvitationPage rebuild(void Function(InvitationPageBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  InvitationPageBuilder toBuilder() => InvitationPageBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is InvitationPage &&
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
    return (newBuiltValueToStringHelper(r'InvitationPage')
          ..add('items', items)
          ..add('nextCursor', nextCursor))
        .toString();
  }
}

class InvitationPageBuilder
    implements Builder<InvitationPage, InvitationPageBuilder> {
  _$InvitationPage? _$v;

  ListBuilder<Invitation>? _items;
  ListBuilder<Invitation> get items =>
      _$this._items ??= ListBuilder<Invitation>();
  set items(ListBuilder<Invitation>? items) => _$this._items = items;

  String? _nextCursor;
  String? get nextCursor => _$this._nextCursor;
  set nextCursor(String? nextCursor) => _$this._nextCursor = nextCursor;

  InvitationPageBuilder() {
    InvitationPage._defaults(this);
  }

  InvitationPageBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _items = $v.items.toBuilder();
      _nextCursor = $v.nextCursor;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(InvitationPage other) {
    _$v = other as _$InvitationPage;
  }

  @override
  void update(void Function(InvitationPageBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  InvitationPage build() => _build();

  _$InvitationPage _build() {
    _$InvitationPage _$result;
    try {
      _$result = _$v ??
          _$InvitationPage._(
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
            r'InvitationPage', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint

// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invitation_create.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$InvitationCreate extends InvitationCreate {
  @override
  final String? note;

  factory _$InvitationCreate(
          [void Function(InvitationCreateBuilder)? updates]) =>
      (InvitationCreateBuilder()..update(updates))._build();

  _$InvitationCreate._({this.note}) : super._();
  @override
  InvitationCreate rebuild(void Function(InvitationCreateBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  InvitationCreateBuilder toBuilder() =>
      InvitationCreateBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is InvitationCreate && note == other.note;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, note.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'InvitationCreate')..add('note', note))
        .toString();
  }
}

class InvitationCreateBuilder
    implements Builder<InvitationCreate, InvitationCreateBuilder> {
  _$InvitationCreate? _$v;

  String? _note;
  String? get note => _$this._note;
  set note(String? note) => _$this._note = note;

  InvitationCreateBuilder() {
    InvitationCreate._defaults(this);
  }

  InvitationCreateBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _note = $v.note;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(InvitationCreate other) {
    _$v = other as _$InvitationCreate;
  }

  @override
  void update(void Function(InvitationCreateBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  InvitationCreate build() => _build();

  _$InvitationCreate _build() {
    final _$result = _$v ??
        _$InvitationCreate._(
          note: note,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint

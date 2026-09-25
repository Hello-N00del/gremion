import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../models/calendar_event.dart';
import '../../services/api_client.dart';
import '../../tokens/app_tokens.dart';

class EventEditScreen extends StatefulWidget {
  const EventEditScreen({this.event, super.key});
  final CalendarEvent? event;
  @override
  State<EventEditScreen> createState() => _EventEditScreenState();
}

class _EventEditScreenState extends State<EventEditScreen> {
  final _titleCtrl = TextEditingController();
  final _locationCtrl = TextEditingController();
  late DateTime _start;
  late DateTime _end;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _start =
        widget.event?.start ?? DateTime.now().add(const Duration(hours: 1));
    _end = widget.event?.end ?? _start.add(const Duration(hours: 1));
    _titleCtrl.text = widget.event?.title ?? '';
    _locationCtrl.text = widget.event?.location ?? '';
  }

  @override
  void dispose() {
    _titleCtrl.dispose();
    _locationCtrl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_titleCtrl.text.trim().isEmpty) return;
    setState(() => _saving = true);
    try {
      final api = context.read<StuRaOSApiClient>();
      final event = CalendarEvent(
        uid: widget.event?.uid ?? '',
        title: _titleCtrl.text.trim(),
        start: _start,
        end: _end,
        location: _locationCtrl.text.trim().isEmpty
            ? null
            : _locationCtrl.text.trim(),
      );
      if (widget.event == null) {
        await api.createEvent(event);
      } else {
        await api.updateEvent(event);
      }
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Speichern fehlgeschlagen: $e')));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _delete() async {
    if (widget.event == null) return;
    await context.read<StuRaOSApiClient>().deleteEvent(widget.event!.uid);
    if (mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title:
              Text(widget.event == null ? 'Neuer Termin' : 'Termin bearbeiten'),
          actions: [
            if (widget.event != null)
              IconButton(
                icon: Icon(Icons.delete_outline,
                    color: AppColors.of(context).danger),
                onPressed: _delete,
              ),
            TextButton(
              onPressed: _saving ? null : _save,
              child: const Text('Speichern'),
            ),
          ],
        ),
        body: ListView(padding: const EdgeInsets.all(AppSpacing.md), children: [
          TextField(
            controller: _titleCtrl,
            decoration: const InputDecoration(labelText: 'Titel'),
          ),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _locationCtrl,
            decoration: const InputDecoration(labelText: 'Ort (optional)'),
          ),
          const SizedBox(height: AppSpacing.md),
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Beginn'),
            trailing: Text(_start.toString()),
            onTap: () async {
              final d = await _showDateTimePicker(context, _start);
              if (d != null) setState(() => _start = d);
            },
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Ende'),
            trailing: Text(_end.toString()),
            onTap: () async {
              final d = await _showDateTimePicker(context, _end);
              if (d != null) setState(() => _end = d);
            },
          ),
        ]),
      );
}

Future<DateTime?> _showDateTimePicker(
    BuildContext context, DateTime initial) async {
  final date = await showDatePicker(
    context: context,
    initialDate: initial,
    firstDate: DateTime(2020),
    lastDate: DateTime(2030),
  );
  if (date == null) return null;
  if (!context.mounted) return null;
  final time = await showTimePicker(
    context: context,
    initialTime: TimeOfDay.fromDateTime(initial),
  );
  if (time == null) return null;
  return DateTime(date.year, date.month, date.day, time.hour, time.minute);
}

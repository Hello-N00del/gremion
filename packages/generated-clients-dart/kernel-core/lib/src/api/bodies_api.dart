//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

import 'dart:async';

import 'package:built_value/json_object.dart';
import 'package:built_value/serializer.dart';
import 'package:dio/dio.dart';

import 'package:gremion_kernel_core_client/src/api_util.dart';
import 'package:gremion_kernel_core_client/src/model/body_tree.dart';
import 'package:gremion_kernel_core_client/src/model/create_body.dart';
import 'package:gremion_kernel_core_client/src/model/customer_settings.dart';
import 'package:gremion_kernel_core_client/src/model/date.dart';
import 'package:gremion_kernel_core_client/src/model/invite_person.dart';
import 'package:gremion_kernel_core_client/src/model/membership_list.dart';
import 'package:gremion_kernel_core_client/src/model/person.dart';
import 'package:gremion_kernel_core_client/src/model/preference.dart';
import 'package:gremion_kernel_core_client/src/model/preference_patch.dart';
import 'package:gremion_kernel_core_client/src/model/problem.dart';
import 'package:gremion_kernel_core_client/src/model/seat_list.dart';
import 'package:gremion_kernel_core_client/src/model/seat_tenures.dart';
import 'package:gremion_kernel_core_client/src/model/start_membership.dart';
import 'package:gremion_kernel_core_client/src/model/written.dart';

class BodiesApi {

  final Dio _dio;

  final Serializers _serializers;

  const BodiesApi(this._dio, this._serializers);

  /// Creates a body (a Gremium)
  /// A person&#39;s write: asked of the WriteAuthorizer first. The shipped authorizer is default deny (Q4), so this answers 403 until TASK-081 binds the PDP; nothing is written and no event is emitted on a refusal.
  ///
  /// Parameters:
  /// * [createBody] 
  /// * [xForwardedHost] - The customer's host, whole (Tenancy D1). Must equal Host. Absent on a module-caller request.
  /// * [xProxyTrust] - The proxy shared secret (TENANT_PROXY_SHARED_SECRET). Absent on a module-caller request.
  /// * [cancelToken] - A [CancelToken] that can be used to cancel the operation
  /// * [headers] - Can be used to add additional headers to the request
  /// * [extras] - Can be used to add flags to the request
  /// * [validateStatus] - A [ValidateStatus] callback that can be used to determine request success based on the HTTP status of the response
  /// * [onSendProgress] - A [ProgressCallback] that can be used to get the send progress
  /// * [onReceiveProgress] - A [ProgressCallback] that can be used to get the receive progress
  ///
  /// Returns a [Future] containing a [Response] with a [Written] as data
  /// Throws [DioException] if API call or serialization fails
  Future<Response<Written>> createBody({ 
    required CreateBody createBody,
    String? xForwardedHost,
    String? xProxyTrust,
    CancelToken? cancelToken,
    Map<String, dynamic>? headers,
    Map<String, dynamic>? extra,
    ValidateStatus? validateStatus,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    final _path = r'/api/v1/bodies';
    final _options = Options(
      method: r'POST',
      headers: <String, dynamic>{
        if (xForwardedHost != null) r'x-forwarded-host': xForwardedHost,
        if (xProxyTrust != null) r'x-proxy-trust': xProxyTrust,
        ...?headers,
      },
      extra: <String, dynamic>{
        'secure': <Map<String, String>>[
          {
            'type': 'http',
            'scheme': 'bearer',
            'name': 'bearer',
          },
        ],
        ...?extra,
      },
      contentType: 'application/json',
      validateStatus: validateStatus,
    );

    dynamic _bodyData;

    try {
      const _type = FullType(CreateBody);
      _bodyData = _serializers.serialize(createBody, specifiedType: _type);

    } catch(error, stackTrace) {
      throw DioException(
         requestOptions: _options.compose(
          _dio.options,
          _path,
        ),
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    final _response = await _dio.request<Object>(
      _path,
      data: _bodyData,
      options: _options,
      cancelToken: cancelToken,
      onSendProgress: onSendProgress,
      onReceiveProgress: onReceiveProgress,
    );

    Written? _responseData;

    try {
      final rawResponse = _response.data;
      _responseData = rawResponse == null ? null : _serializers.deserialize(
        rawResponse,
        specifiedType: const FullType(Written),
      ) as Written;

    } catch (error, stackTrace) {
      throw DioException(
        requestOptions: _response.requestOptions,
        response: _response,
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    return Response<Written>(
      data: _responseData,
      headers: _response.headers,
      isRedirect: _response.isRedirect,
      requestOptions: _response.requestOptions,
      redirects: _response.redirects,
      statusCode: _response.statusCode,
      statusMessage: _response.statusMessage,
      extra: _response.extra,
    );
  }

  /// Every body and org unit of the customer
  /// 
  ///
  /// Parameters:
  /// * [xForwardedHost] - The customer's host, whole (Tenancy D1). Must equal Host. Absent on a module-caller request.
  /// * [xProxyTrust] - The proxy shared secret (TENANT_PROXY_SHARED_SECRET). Absent on a module-caller request.
  /// * [cancelToken] - A [CancelToken] that can be used to cancel the operation
  /// * [headers] - Can be used to add additional headers to the request
  /// * [extras] - Can be used to add flags to the request
  /// * [validateStatus] - A [ValidateStatus] callback that can be used to determine request success based on the HTTP status of the response
  /// * [onSendProgress] - A [ProgressCallback] that can be used to get the send progress
  /// * [onReceiveProgress] - A [ProgressCallback] that can be used to get the receive progress
  ///
  /// Returns a [Future] containing a [Response] with a [BodyTree] as data
  /// Throws [DioException] if API call or serialization fails
  Future<Response<BodyTree>> getBodyTree({ 
    String? xForwardedHost,
    String? xProxyTrust,
    CancelToken? cancelToken,
    Map<String, dynamic>? headers,
    Map<String, dynamic>? extra,
    ValidateStatus? validateStatus,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    final _path = r'/api/v1/bodies/tree';
    final _options = Options(
      method: r'GET',
      headers: <String, dynamic>{
        if (xForwardedHost != null) r'x-forwarded-host': xForwardedHost,
        if (xProxyTrust != null) r'x-proxy-trust': xProxyTrust,
        ...?headers,
      },
      extra: <String, dynamic>{
        'secure': <Map<String, String>>[
          {
            'type': 'http',
            'scheme': 'bearer',
            'name': 'bearer',
          },
        ],
        ...?extra,
      },
      validateStatus: validateStatus,
    );

    final _response = await _dio.request<Object>(
      _path,
      options: _options,
      cancelToken: cancelToken,
      onSendProgress: onSendProgress,
      onReceiveProgress: onReceiveProgress,
    );

    BodyTree? _responseData;

    try {
      final rawResponse = _response.data;
      _responseData = rawResponse == null ? null : _serializers.deserialize(
        rawResponse,
        specifiedType: const FullType(BodyTree),
      ) as BodyTree;

    } catch (error, stackTrace) {
      throw DioException(
        requestOptions: _response.requestOptions,
        response: _response,
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    return Response<BodyTree>(
      data: _responseData,
      headers: _response.headers,
      isRedirect: _response.isRedirect,
      requestOptions: _response.requestOptions,
      redirects: _response.redirects,
      statusCode: _response.statusCode,
      statusMessage: _response.statusMessage,
      extra: _response.extra,
    );
  }

  /// The customer&#39;s settings that shape every person&#39;s UI
  /// 
  ///
  /// Parameters:
  /// * [xForwardedHost] - The customer's host, whole (Tenancy D1). Must equal Host. Absent on a module-caller request.
  /// * [xProxyTrust] - The proxy shared secret (TENANT_PROXY_SHARED_SECRET). Absent on a module-caller request.
  /// * [cancelToken] - A [CancelToken] that can be used to cancel the operation
  /// * [headers] - Can be used to add additional headers to the request
  /// * [extras] - Can be used to add flags to the request
  /// * [validateStatus] - A [ValidateStatus] callback that can be used to determine request success based on the HTTP status of the response
  /// * [onSendProgress] - A [ProgressCallback] that can be used to get the send progress
  /// * [onReceiveProgress] - A [ProgressCallback] that can be used to get the receive progress
  ///
  /// Returns a [Future] containing a [Response] with a [CustomerSettings] as data
  /// Throws [DioException] if API call or serialization fails
  Future<Response<CustomerSettings>> getCustomerSettings({ 
    String? xForwardedHost,
    String? xProxyTrust,
    CancelToken? cancelToken,
    Map<String, dynamic>? headers,
    Map<String, dynamic>? extra,
    ValidateStatus? validateStatus,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    final _path = r'/api/v1/customer/settings';
    final _options = Options(
      method: r'GET',
      headers: <String, dynamic>{
        if (xForwardedHost != null) r'x-forwarded-host': xForwardedHost,
        if (xProxyTrust != null) r'x-proxy-trust': xProxyTrust,
        ...?headers,
      },
      extra: <String, dynamic>{
        'secure': <Map<String, String>>[
          {
            'type': 'http',
            'scheme': 'bearer',
            'name': 'bearer',
          },
        ],
        ...?extra,
      },
      validateStatus: validateStatus,
    );

    final _response = await _dio.request<Object>(
      _path,
      options: _options,
      cancelToken: cancelToken,
      onSendProgress: onSendProgress,
      onReceiveProgress: onReceiveProgress,
    );

    CustomerSettings? _responseData;

    try {
      final rawResponse = _response.data;
      _responseData = rawResponse == null ? null : _serializers.deserialize(
        rawResponse,
        specifiedType: const FullType(CustomerSettings),
      ) as CustomerSettings;

    } catch (error, stackTrace) {
      throw DioException(
        requestOptions: _response.requestOptions,
        response: _response,
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    return Response<CustomerSettings>(
      data: _responseData,
      headers: _response.headers,
      isRedirect: _response.isRedirect,
      requestOptions: _response.requestOptions,
      redirects: _response.redirects,
      statusCode: _response.statusCode,
      statusMessage: _response.statusMessage,
      extra: _response.extra,
    );
  }

  /// The signed-in person&#39;s own preference
  /// 
  ///
  /// Parameters:
  /// * [xForwardedHost] - The customer's host, whole (Tenancy D1). Must equal Host. Absent on a module-caller request.
  /// * [xProxyTrust] - The proxy shared secret (TENANT_PROXY_SHARED_SECRET). Absent on a module-caller request.
  /// * [cancelToken] - A [CancelToken] that can be used to cancel the operation
  /// * [headers] - Can be used to add additional headers to the request
  /// * [extras] - Can be used to add flags to the request
  /// * [validateStatus] - A [ValidateStatus] callback that can be used to determine request success based on the HTTP status of the response
  /// * [onSendProgress] - A [ProgressCallback] that can be used to get the send progress
  /// * [onReceiveProgress] - A [ProgressCallback] that can be used to get the receive progress
  ///
  /// Returns a [Future] containing a [Response] with a [Preference] as data
  /// Throws [DioException] if API call or serialization fails
  Future<Response<Preference>> getOwnPreference({ 
    String? xForwardedHost,
    String? xProxyTrust,
    CancelToken? cancelToken,
    Map<String, dynamic>? headers,
    Map<String, dynamic>? extra,
    ValidateStatus? validateStatus,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    final _path = r'/api/v1/persons/me/preference';
    final _options = Options(
      method: r'GET',
      headers: <String, dynamic>{
        if (xForwardedHost != null) r'x-forwarded-host': xForwardedHost,
        if (xProxyTrust != null) r'x-proxy-trust': xProxyTrust,
        ...?headers,
      },
      extra: <String, dynamic>{
        'secure': <Map<String, String>>[
          {
            'type': 'http',
            'scheme': 'bearer',
            'name': 'bearer',
          },
        ],
        ...?extra,
      },
      validateStatus: validateStatus,
    );

    final _response = await _dio.request<Object>(
      _path,
      options: _options,
      cancelToken: cancelToken,
      onSendProgress: onSendProgress,
      onReceiveProgress: onReceiveProgress,
    );

    Preference? _responseData;

    try {
      final rawResponse = _response.data;
      _responseData = rawResponse == null ? null : _serializers.deserialize(
        rawResponse,
        specifiedType: const FullType(Preference),
      ) as Preference;

    } catch (error, stackTrace) {
      throw DioException(
        requestOptions: _response.requestOptions,
        response: _response,
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    return Response<Preference>(
      data: _responseData,
      headers: _response.headers,
      isRedirect: _response.isRedirect,
      requestOptions: _response.requestOptions,
      redirects: _response.redirects,
      statusCode: _response.statusCode,
      statusMessage: _response.statusMessage,
      extra: _response.extra,
    );
  }

  /// A person (their own record only)
  /// 
  ///
  /// Parameters:
  /// * [personId] - A person of the resolved customer.
  /// * [xForwardedHost] - The customer's host, whole (Tenancy D1). Must equal Host. Absent on a module-caller request.
  /// * [xProxyTrust] - The proxy shared secret (TENANT_PROXY_SHARED_SECRET). Absent on a module-caller request.
  /// * [cancelToken] - A [CancelToken] that can be used to cancel the operation
  /// * [headers] - Can be used to add additional headers to the request
  /// * [extras] - Can be used to add flags to the request
  /// * [validateStatus] - A [ValidateStatus] callback that can be used to determine request success based on the HTTP status of the response
  /// * [onSendProgress] - A [ProgressCallback] that can be used to get the send progress
  /// * [onReceiveProgress] - A [ProgressCallback] that can be used to get the receive progress
  ///
  /// Returns a [Future] containing a [Response] with a [Person] as data
  /// Throws [DioException] if API call or serialization fails
  Future<Response<Person>> getPerson({ 
    required String personId,
    String? xForwardedHost,
    String? xProxyTrust,
    CancelToken? cancelToken,
    Map<String, dynamic>? headers,
    Map<String, dynamic>? extra,
    ValidateStatus? validateStatus,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    final _path = r'/api/v1/persons/{personId}'.replaceAll('{' r'personId' '}', encodeQueryParameter(_serializers, personId, const FullType(String)).toString());
    final _options = Options(
      method: r'GET',
      headers: <String, dynamic>{
        if (xForwardedHost != null) r'x-forwarded-host': xForwardedHost,
        if (xProxyTrust != null) r'x-proxy-trust': xProxyTrust,
        ...?headers,
      },
      extra: <String, dynamic>{
        'secure': <Map<String, String>>[
          {
            'type': 'http',
            'scheme': 'bearer',
            'name': 'bearer',
          },
        ],
        ...?extra,
      },
      validateStatus: validateStatus,
    );

    final _response = await _dio.request<Object>(
      _path,
      options: _options,
      cancelToken: cancelToken,
      onSendProgress: onSendProgress,
      onReceiveProgress: onReceiveProgress,
    );

    Person? _responseData;

    try {
      final rawResponse = _response.data;
      _responseData = rawResponse == null ? null : _serializers.deserialize(
        rawResponse,
        specifiedType: const FullType(Person),
      ) as Person;

    } catch (error, stackTrace) {
      throw DioException(
        requestOptions: _response.requestOptions,
        response: _response,
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    return Response<Person>(
      data: _responseData,
      headers: _response.headers,
      isRedirect: _response.isRedirect,
      requestOptions: _response.requestOptions,
      redirects: _response.redirects,
      statusCode: _response.statusCode,
      statusMessage: _response.statusMessage,
      extra: _response.extra,
    );
  }

  /// Invites a person
  /// A person&#39;s write: asked of the WriteAuthorizer first. The shipped authorizer is default deny (Q4), so this answers 403 until TASK-081 binds the PDP; nothing is written and no event is emitted on a refusal.
  ///
  /// Parameters:
  /// * [invitePerson] 
  /// * [xForwardedHost] - The customer's host, whole (Tenancy D1). Must equal Host. Absent on a module-caller request.
  /// * [xProxyTrust] - The proxy shared secret (TENANT_PROXY_SHARED_SECRET). Absent on a module-caller request.
  /// * [cancelToken] - A [CancelToken] that can be used to cancel the operation
  /// * [headers] - Can be used to add additional headers to the request
  /// * [extras] - Can be used to add flags to the request
  /// * [validateStatus] - A [ValidateStatus] callback that can be used to determine request success based on the HTTP status of the response
  /// * [onSendProgress] - A [ProgressCallback] that can be used to get the send progress
  /// * [onReceiveProgress] - A [ProgressCallback] that can be used to get the receive progress
  ///
  /// Returns a [Future] containing a [Response] with a [Written] as data
  /// Throws [DioException] if API call or serialization fails
  Future<Response<Written>> invitePerson({ 
    required InvitePerson invitePerson,
    String? xForwardedHost,
    String? xProxyTrust,
    CancelToken? cancelToken,
    Map<String, dynamic>? headers,
    Map<String, dynamic>? extra,
    ValidateStatus? validateStatus,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    final _path = r'/api/v1/persons';
    final _options = Options(
      method: r'POST',
      headers: <String, dynamic>{
        if (xForwardedHost != null) r'x-forwarded-host': xForwardedHost,
        if (xProxyTrust != null) r'x-proxy-trust': xProxyTrust,
        ...?headers,
      },
      extra: <String, dynamic>{
        'secure': <Map<String, String>>[
          {
            'type': 'http',
            'scheme': 'bearer',
            'name': 'bearer',
          },
        ],
        ...?extra,
      },
      contentType: 'application/json',
      validateStatus: validateStatus,
    );

    dynamic _bodyData;

    try {
      const _type = FullType(InvitePerson);
      _bodyData = _serializers.serialize(invitePerson, specifiedType: _type);

    } catch(error, stackTrace) {
      throw DioException(
         requestOptions: _options.compose(
          _dio.options,
          _path,
        ),
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    final _response = await _dio.request<Object>(
      _path,
      data: _bodyData,
      options: _options,
      cancelToken: cancelToken,
      onSendProgress: onSendProgress,
      onReceiveProgress: onReceiveProgress,
    );

    Written? _responseData;

    try {
      final rawResponse = _response.data;
      _responseData = rawResponse == null ? null : _serializers.deserialize(
        rawResponse,
        specifiedType: const FullType(Written),
      ) as Written;

    } catch (error, stackTrace) {
      throw DioException(
        requestOptions: _response.requestOptions,
        response: _response,
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    return Response<Written>(
      data: _responseData,
      headers: _response.headers,
      isRedirect: _response.isRedirect,
      requestOptions: _response.requestOptions,
      redirects: _response.redirects,
      statusCode: _response.statusCode,
      statusMessage: _response.statusMessage,
      extra: _response.extra,
    );
  }

  /// The memberships of a body valid on a day
  /// 
  ///
  /// Parameters:
  /// * [bodyId] - A body of the resolved customer.
  /// * [xForwardedHost] - The customer's host, whole (Tenancy D1). Must equal Host. Absent on a module-caller request.
  /// * [xProxyTrust] - The proxy shared secret (TENANT_PROXY_SHARED_SECRET). Absent on a module-caller request.
  /// * [asOf] - The day (default: today, UTC).
  /// * [cancelToken] - A [CancelToken] that can be used to cancel the operation
  /// * [headers] - Can be used to add additional headers to the request
  /// * [extras] - Can be used to add flags to the request
  /// * [validateStatus] - A [ValidateStatus] callback that can be used to determine request success based on the HTTP status of the response
  /// * [onSendProgress] - A [ProgressCallback] that can be used to get the send progress
  /// * [onReceiveProgress] - A [ProgressCallback] that can be used to get the receive progress
  ///
  /// Returns a [Future] containing a [Response] with a [MembershipList] as data
  /// Throws [DioException] if API call or serialization fails
  Future<Response<MembershipList>> listBodyMemberships({ 
    required String bodyId,
    String? xForwardedHost,
    String? xProxyTrust,
    Date? asOf,
    CancelToken? cancelToken,
    Map<String, dynamic>? headers,
    Map<String, dynamic>? extra,
    ValidateStatus? validateStatus,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    final _path = r'/api/v1/bodies/{bodyId}/memberships'.replaceAll('{' r'bodyId' '}', encodeQueryParameter(_serializers, bodyId, const FullType(String)).toString());
    final _options = Options(
      method: r'GET',
      headers: <String, dynamic>{
        if (xForwardedHost != null) r'x-forwarded-host': xForwardedHost,
        if (xProxyTrust != null) r'x-proxy-trust': xProxyTrust,
        ...?headers,
      },
      extra: <String, dynamic>{
        'secure': <Map<String, String>>[
          {
            'type': 'http',
            'scheme': 'bearer',
            'name': 'bearer',
          },
        ],
        ...?extra,
      },
      validateStatus: validateStatus,
    );

    final _queryParameters = <String, dynamic>{
      if (asOf != null) r'asOf': encodeQueryParameter(_serializers, asOf, const FullType(Date)),
    };

    final _response = await _dio.request<Object>(
      _path,
      options: _options,
      queryParameters: _queryParameters,
      cancelToken: cancelToken,
      onSendProgress: onSendProgress,
      onReceiveProgress: onReceiveProgress,
    );

    MembershipList? _responseData;

    try {
      final rawResponse = _response.data;
      _responseData = rawResponse == null ? null : _serializers.deserialize(
        rawResponse,
        specifiedType: const FullType(MembershipList),
      ) as MembershipList;

    } catch (error, stackTrace) {
      throw DioException(
        requestOptions: _response.requestOptions,
        response: _response,
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    return Response<MembershipList>(
      data: _responseData,
      headers: _response.headers,
      isRedirect: _response.isRedirect,
      requestOptions: _response.requestOptions,
      redirects: _response.redirects,
      statusCode: _response.statusCode,
      statusMessage: _response.statusMessage,
      extra: _response.extra,
    );
  }

  /// The seats of a body with their current holders
  /// 
  ///
  /// Parameters:
  /// * [bodyId] - A body of the resolved customer.
  /// * [xForwardedHost] - The customer's host, whole (Tenancy D1). Must equal Host. Absent on a module-caller request.
  /// * [xProxyTrust] - The proxy shared secret (TENANT_PROXY_SHARED_SECRET). Absent on a module-caller request.
  /// * [cancelToken] - A [CancelToken] that can be used to cancel the operation
  /// * [headers] - Can be used to add additional headers to the request
  /// * [extras] - Can be used to add flags to the request
  /// * [validateStatus] - A [ValidateStatus] callback that can be used to determine request success based on the HTTP status of the response
  /// * [onSendProgress] - A [ProgressCallback] that can be used to get the send progress
  /// * [onReceiveProgress] - A [ProgressCallback] that can be used to get the receive progress
  ///
  /// Returns a [Future] containing a [Response] with a [SeatList] as data
  /// Throws [DioException] if API call or serialization fails
  Future<Response<SeatList>> listBodySeats({ 
    required String bodyId,
    String? xForwardedHost,
    String? xProxyTrust,
    CancelToken? cancelToken,
    Map<String, dynamic>? headers,
    Map<String, dynamic>? extra,
    ValidateStatus? validateStatus,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    final _path = r'/api/v1/bodies/{bodyId}/seats'.replaceAll('{' r'bodyId' '}', encodeQueryParameter(_serializers, bodyId, const FullType(String)).toString());
    final _options = Options(
      method: r'GET',
      headers: <String, dynamic>{
        if (xForwardedHost != null) r'x-forwarded-host': xForwardedHost,
        if (xProxyTrust != null) r'x-proxy-trust': xProxyTrust,
        ...?headers,
      },
      extra: <String, dynamic>{
        'secure': <Map<String, String>>[
          {
            'type': 'http',
            'scheme': 'bearer',
            'name': 'bearer',
          },
        ],
        ...?extra,
      },
      validateStatus: validateStatus,
    );

    final _response = await _dio.request<Object>(
      _path,
      options: _options,
      cancelToken: cancelToken,
      onSendProgress: onSendProgress,
      onReceiveProgress: onReceiveProgress,
    );

    SeatList? _responseData;

    try {
      final rawResponse = _response.data;
      _responseData = rawResponse == null ? null : _serializers.deserialize(
        rawResponse,
        specifiedType: const FullType(SeatList),
      ) as SeatList;

    } catch (error, stackTrace) {
      throw DioException(
        requestOptions: _response.requestOptions,
        response: _response,
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    return Response<SeatList>(
      data: _responseData,
      headers: _response.headers,
      isRedirect: _response.isRedirect,
      requestOptions: _response.requestOptions,
      redirects: _response.redirects,
      statusCode: _response.statusCode,
      statusMessage: _response.statusMessage,
      extra: _response.extra,
    );
  }

  /// The history of a seat: every tenure, newest first
  /// 
  ///
  /// Parameters:
  /// * [seatId] - A seat of the resolved customer.
  /// * [xForwardedHost] - The customer's host, whole (Tenancy D1). Must equal Host. Absent on a module-caller request.
  /// * [xProxyTrust] - The proxy shared secret (TENANT_PROXY_SHARED_SECRET). Absent on a module-caller request.
  /// * [cancelToken] - A [CancelToken] that can be used to cancel the operation
  /// * [headers] - Can be used to add additional headers to the request
  /// * [extras] - Can be used to add flags to the request
  /// * [validateStatus] - A [ValidateStatus] callback that can be used to determine request success based on the HTTP status of the response
  /// * [onSendProgress] - A [ProgressCallback] that can be used to get the send progress
  /// * [onReceiveProgress] - A [ProgressCallback] that can be used to get the receive progress
  ///
  /// Returns a [Future] containing a [Response] with a [SeatTenures] as data
  /// Throws [DioException] if API call or serialization fails
  Future<Response<SeatTenures>> listSeatTenures({ 
    required String seatId,
    String? xForwardedHost,
    String? xProxyTrust,
    CancelToken? cancelToken,
    Map<String, dynamic>? headers,
    Map<String, dynamic>? extra,
    ValidateStatus? validateStatus,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    final _path = r'/api/v1/seats/{seatId}/tenures'.replaceAll('{' r'seatId' '}', encodeQueryParameter(_serializers, seatId, const FullType(String)).toString());
    final _options = Options(
      method: r'GET',
      headers: <String, dynamic>{
        if (xForwardedHost != null) r'x-forwarded-host': xForwardedHost,
        if (xProxyTrust != null) r'x-proxy-trust': xProxyTrust,
        ...?headers,
      },
      extra: <String, dynamic>{
        'secure': <Map<String, String>>[
          {
            'type': 'http',
            'scheme': 'bearer',
            'name': 'bearer',
          },
        ],
        ...?extra,
      },
      validateStatus: validateStatus,
    );

    final _response = await _dio.request<Object>(
      _path,
      options: _options,
      cancelToken: cancelToken,
      onSendProgress: onSendProgress,
      onReceiveProgress: onReceiveProgress,
    );

    SeatTenures? _responseData;

    try {
      final rawResponse = _response.data;
      _responseData = rawResponse == null ? null : _serializers.deserialize(
        rawResponse,
        specifiedType: const FullType(SeatTenures),
      ) as SeatTenures;

    } catch (error, stackTrace) {
      throw DioException(
        requestOptions: _response.requestOptions,
        response: _response,
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    return Response<SeatTenures>(
      data: _responseData,
      headers: _response.headers,
      isRedirect: _response.isRedirect,
      requestOptions: _response.requestOptions,
      redirects: _response.redirects,
      statusCode: _response.statusCode,
      statusMessage: _response.statusMessage,
      extra: _response.extra,
    );
  }

  /// Saves the signed-in person&#39;s own preference
  /// 
  ///
  /// Parameters:
  /// * [preferencePatch] 
  /// * [xForwardedHost] - The customer's host, whole (Tenancy D1). Must equal Host. Absent on a module-caller request.
  /// * [xProxyTrust] - The proxy shared secret (TENANT_PROXY_SHARED_SECRET). Absent on a module-caller request.
  /// * [cancelToken] - A [CancelToken] that can be used to cancel the operation
  /// * [headers] - Can be used to add additional headers to the request
  /// * [extras] - Can be used to add flags to the request
  /// * [validateStatus] - A [ValidateStatus] callback that can be used to determine request success based on the HTTP status of the response
  /// * [onSendProgress] - A [ProgressCallback] that can be used to get the send progress
  /// * [onReceiveProgress] - A [ProgressCallback] that can be used to get the receive progress
  ///
  /// Returns a [Future] containing a [Response] with a [Preference] as data
  /// Throws [DioException] if API call or serialization fails
  Future<Response<Preference>> putOwnPreference({ 
    required PreferencePatch preferencePatch,
    String? xForwardedHost,
    String? xProxyTrust,
    CancelToken? cancelToken,
    Map<String, dynamic>? headers,
    Map<String, dynamic>? extra,
    ValidateStatus? validateStatus,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    final _path = r'/api/v1/persons/me/preference';
    final _options = Options(
      method: r'PUT',
      headers: <String, dynamic>{
        if (xForwardedHost != null) r'x-forwarded-host': xForwardedHost,
        if (xProxyTrust != null) r'x-proxy-trust': xProxyTrust,
        ...?headers,
      },
      extra: <String, dynamic>{
        'secure': <Map<String, String>>[
          {
            'type': 'http',
            'scheme': 'bearer',
            'name': 'bearer',
          },
        ],
        ...?extra,
      },
      contentType: 'application/json',
      validateStatus: validateStatus,
    );

    dynamic _bodyData;

    try {
      const _type = FullType(PreferencePatch);
      _bodyData = _serializers.serialize(preferencePatch, specifiedType: _type);

    } catch(error, stackTrace) {
      throw DioException(
         requestOptions: _options.compose(
          _dio.options,
          _path,
        ),
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    final _response = await _dio.request<Object>(
      _path,
      data: _bodyData,
      options: _options,
      cancelToken: cancelToken,
      onSendProgress: onSendProgress,
      onReceiveProgress: onReceiveProgress,
    );

    Preference? _responseData;

    try {
      final rawResponse = _response.data;
      _responseData = rawResponse == null ? null : _serializers.deserialize(
        rawResponse,
        specifiedType: const FullType(Preference),
      ) as Preference;

    } catch (error, stackTrace) {
      throw DioException(
        requestOptions: _response.requestOptions,
        response: _response,
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    return Response<Preference>(
      data: _responseData,
      headers: _response.headers,
      isRedirect: _response.isRedirect,
      requestOptions: _response.requestOptions,
      redirects: _response.redirects,
      statusCode: _response.statusCode,
      statusMessage: _response.statusMessage,
      extra: _response.extra,
    );
  }

  /// Starts a membership in a body
  /// A person&#39;s write: asked of the WriteAuthorizer first. The shipped authorizer is default deny (Q4), so this answers 403 until TASK-081 binds the PDP; nothing is written and no event is emitted on a refusal.
  ///
  /// Parameters:
  /// * [bodyId] - A body of the resolved customer.
  /// * [startMembership] 
  /// * [xForwardedHost] - The customer's host, whole (Tenancy D1). Must equal Host. Absent on a module-caller request.
  /// * [xProxyTrust] - The proxy shared secret (TENANT_PROXY_SHARED_SECRET). Absent on a module-caller request.
  /// * [cancelToken] - A [CancelToken] that can be used to cancel the operation
  /// * [headers] - Can be used to add additional headers to the request
  /// * [extras] - Can be used to add flags to the request
  /// * [validateStatus] - A [ValidateStatus] callback that can be used to determine request success based on the HTTP status of the response
  /// * [onSendProgress] - A [ProgressCallback] that can be used to get the send progress
  /// * [onReceiveProgress] - A [ProgressCallback] that can be used to get the receive progress
  ///
  /// Returns a [Future] containing a [Response] with a [Written] as data
  /// Throws [DioException] if API call or serialization fails
  Future<Response<Written>> startMembership({ 
    required String bodyId,
    required StartMembership startMembership,
    String? xForwardedHost,
    String? xProxyTrust,
    CancelToken? cancelToken,
    Map<String, dynamic>? headers,
    Map<String, dynamic>? extra,
    ValidateStatus? validateStatus,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    final _path = r'/api/v1/bodies/{bodyId}/memberships'.replaceAll('{' r'bodyId' '}', encodeQueryParameter(_serializers, bodyId, const FullType(String)).toString());
    final _options = Options(
      method: r'POST',
      headers: <String, dynamic>{
        if (xForwardedHost != null) r'x-forwarded-host': xForwardedHost,
        if (xProxyTrust != null) r'x-proxy-trust': xProxyTrust,
        ...?headers,
      },
      extra: <String, dynamic>{
        'secure': <Map<String, String>>[
          {
            'type': 'http',
            'scheme': 'bearer',
            'name': 'bearer',
          },
        ],
        ...?extra,
      },
      contentType: 'application/json',
      validateStatus: validateStatus,
    );

    dynamic _bodyData;

    try {
      const _type = FullType(StartMembership);
      _bodyData = _serializers.serialize(startMembership, specifiedType: _type);

    } catch(error, stackTrace) {
      throw DioException(
         requestOptions: _options.compose(
          _dio.options,
          _path,
        ),
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    final _response = await _dio.request<Object>(
      _path,
      data: _bodyData,
      options: _options,
      cancelToken: cancelToken,
      onSendProgress: onSendProgress,
      onReceiveProgress: onReceiveProgress,
    );

    Written? _responseData;

    try {
      final rawResponse = _response.data;
      _responseData = rawResponse == null ? null : _serializers.deserialize(
        rawResponse,
        specifiedType: const FullType(Written),
      ) as Written;

    } catch (error, stackTrace) {
      throw DioException(
        requestOptions: _response.requestOptions,
        response: _response,
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    return Response<Written>(
      data: _responseData,
      headers: _response.headers,
      isRedirect: _response.isRedirect,
      requestOptions: _response.requestOptions,
      redirects: _response.redirects,
      statusCode: _response.statusCode,
      statusMessage: _response.statusMessage,
      extra: _response.extra,
    );
  }

}

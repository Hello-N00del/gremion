//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

import 'dart:async';

import 'package:built_value/json_object.dart';
import 'package:built_value/serializer.dart';
import 'package:dio/dio.dart';

import 'package:gremion_kernel_core_client/src/model/enabled_modules.dart';
import 'package:gremion_kernel_core_client/src/model/problem.dart';

class ModulesApi {

  final Dio _dio;

  final Serializers _serializers;

  const ModulesApi(this._dio, this._serializers);

  /// The resolved customer&#39;s enabled modules with their runtime declarations
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
  /// Returns a [Future] containing a [Response] with a [EnabledModules] as data
  /// Throws [DioException] if API call or serialization fails
  Future<Response<EnabledModules>> listEnabledModules({ 
    String? xForwardedHost,
    String? xProxyTrust,
    CancelToken? cancelToken,
    Map<String, dynamic>? headers,
    Map<String, dynamic>? extra,
    ValidateStatus? validateStatus,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    final _path = r'/api/v1/modules';
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
            'type': 'apiKey',
            'name': 'moduleCaller',
            'keyName': 'x-internal-auth',
            'where': 'header',
          },{
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

    EnabledModules? _responseData;

    try {
      final rawResponse = _response.data;
      _responseData = rawResponse == null ? null : _serializers.deserialize(
        rawResponse,
        specifiedType: const FullType(EnabledModules),
      ) as EnabledModules;

    } catch (error, stackTrace) {
      throw DioException(
        requestOptions: _response.requestOptions,
        response: _response,
        type: DioExceptionType.unknown,
        error: error,
        stackTrace: stackTrace,
      );
    }

    return Response<EnabledModules>(
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

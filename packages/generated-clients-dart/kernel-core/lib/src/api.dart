//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

import 'package:dio/dio.dart';
import 'package:built_value/serializer.dart';
import 'package:gremion_kernel_core_client/src/serializers.dart';
import 'package:gremion_kernel_core_client/src/auth/api_key_auth.dart';
import 'package:gremion_kernel_core_client/src/auth/basic_auth.dart';
import 'package:gremion_kernel_core_client/src/auth/bearer_auth.dart';
import 'package:gremion_kernel_core_client/src/auth/oauth.dart';
import 'package:gremion_kernel_core_client/src/api/authz_api.dart';
import 'package:gremion_kernel_core_client/src/api/bodies_api.dart';
import 'package:gremion_kernel_core_client/src/api/modules_api.dart';
import 'package:gremion_kernel_core_client/src/api/platform_api.dart';
import 'package:gremion_kernel_core_client/src/api/tenancy_api.dart';

class GremionKernelCoreClient {
  static const String basePath = r'http://localhost';

  final Dio dio;
  final Serializers serializers;

  GremionKernelCoreClient({
    Dio? dio,
    Serializers? serializers,
    String? basePathOverride,
    List<Interceptor>? interceptors,
  })  : this.serializers = serializers ?? standardSerializers,
        this.dio = dio ??
            Dio(BaseOptions(
              baseUrl: basePathOverride ?? basePath,
              connectTimeout: const Duration(milliseconds: 5000),
              receiveTimeout: const Duration(milliseconds: 3000),
            )) {
    if (interceptors == null) {
      this.dio.interceptors.addAll([
        OAuthInterceptor(),
        BasicAuthInterceptor(),
        BearerAuthInterceptor(),
        ApiKeyAuthInterceptor(),
      ]);
    } else {
      this.dio.interceptors.addAll(interceptors);
    }
  }

  void setOAuthToken(String name, String token) {
    if (this.dio.interceptors.any((i) => i is OAuthInterceptor)) {
      (this.dio.interceptors.firstWhere((i) => i is OAuthInterceptor) as OAuthInterceptor).tokens[name] = token;
    }
  }

  void setBearerAuth(String name, String token) {
    if (this.dio.interceptors.any((i) => i is BearerAuthInterceptor)) {
      (this.dio.interceptors.firstWhere((i) => i is BearerAuthInterceptor) as BearerAuthInterceptor).tokens[name] = token;
    }
  }

  void setBasicAuth(String name, String username, String password) {
    if (this.dio.interceptors.any((i) => i is BasicAuthInterceptor)) {
      (this.dio.interceptors.firstWhere((i) => i is BasicAuthInterceptor) as BasicAuthInterceptor).authInfo[name] = BasicAuthInfo(username, password);
    }
  }

  void setApiKey(String name, String apiKey) {
    if (this.dio.interceptors.any((i) => i is ApiKeyAuthInterceptor)) {
      (this.dio.interceptors.firstWhere((element) => element is ApiKeyAuthInterceptor) as ApiKeyAuthInterceptor).apiKeys[name] = apiKey;
    }
  }

  /// Get AuthzApi instance, base route and serializer can be overridden by a given but be careful,
  /// by doing that all interceptors will not be executed
  AuthzApi getAuthzApi() {
    return AuthzApi(dio, serializers);
  }

  /// Get BodiesApi instance, base route and serializer can be overridden by a given but be careful,
  /// by doing that all interceptors will not be executed
  BodiesApi getBodiesApi() {
    return BodiesApi(dio, serializers);
  }

  /// Get ModulesApi instance, base route and serializer can be overridden by a given but be careful,
  /// by doing that all interceptors will not be executed
  ModulesApi getModulesApi() {
    return ModulesApi(dio, serializers);
  }

  /// Get PlatformApi instance, base route and serializer can be overridden by a given but be careful,
  /// by doing that all interceptors will not be executed
  PlatformApi getPlatformApi() {
    return PlatformApi(dio, serializers);
  }

  /// Get TenancyApi instance, base route and serializer can be overridden by a given but be careful,
  /// by doing that all interceptors will not be executed
  TenancyApi getTenancyApi() {
    return TenancyApi(dio, serializers);
  }
}

# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.

# Preserve source line numbers for actionable crash stack traces without exposing paths.
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod,SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Preserve MainActivity and Turnleaf's custom Capacitor reader plugins.
-keep class app.turnleaf.reader.MainActivity { *; }
-keep class app.turnleaf.reader.*Plugin { *; }

# Preserve Capacitor bridge plugins, reflection-discovered annotations, and WebView JS interfaces.
-keep public class * extends com.getcapacitor.Plugin { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep @interface com.getcapacitor.annotation.** { *; }
-keep @interface com.getcapacitor.PluginMethod { *; }
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.annotation.ActivityCallback <methods>;
    @com.getcapacitor.annotation.PermissionCallback <methods>;
}
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Preserve SQLCipher JNI bindings loaded via System.loadLibrary("sqlcipher").
-keep class net.zetetic.database.sqlcipher.** { *; }

# Preserve Tink protobuf fields used by EncryptedSharedPreferences and ignore compile-only annotations.
-keepclassmembers class * extends com.google.crypto.tink.shaded.protobuf.GeneratedMessageLite {
    <fields>;
}
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**

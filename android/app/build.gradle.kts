plugins {
    id("com.android.application")
}

android {
    namespace = "app.rotorlens"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.rotorlens"
        // WebView is updated through the Play Store independently of the OS, but
        // API 26 is a floor where a modern WebView is realistic in practice. The
        // viewer uses ES modules and needs one.
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // "uses or overrides a deprecated API" with no name attached is a warning
    // nobody can act on, and this is the one module in the project a test cannot
    // reach. Name them.
    tasks.withType<JavaCompile>().configureEach {
        options.compilerArgs.addAll(listOf("-Xlint:deprecation", "-Xlint:unchecked"))
    }
}

dependencies {
    // Only for the modern back-press and activity-result APIs. The viewer itself
    // has no dependencies at all; see THIRD_PARTY_NOTICES.md before adding more.
    implementation("androidx.activity:activity:1.9.3")

    // Not new dependencies. Activity drags in coroutines 1.6.4, which asks for
    // kotlin-stdlib-jdk7/jdk8 1.6.21, while everything else pulls kotlin-stdlib
    // up to 1.8.22. Kotlin 1.8 moved the jdk7/jdk8 classes into stdlib itself, so
    // the old 1.6.21 jars and the new stdlib both define kotlin.io.path.PathsKt
    // and D8 fails on the duplicates. Pinning the shims to the same version as
    // stdlib empties them; it does not add anything to the APK.
    constraints {
        implementation("org.jetbrains.kotlin:kotlin-stdlib-jdk7:1.8.22")
        implementation("org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.8.22")
    }

    testImplementation("junit:junit:4.13.2")
}

/**
 * Copies the viewer and the engine into the APK's assets.
 *
 * The app must never ship a stale copy of `src/`. Syncing on every build means
 * there is one engine, the one the tests run against, rather than a duplicate
 * that drifts.
 */
val syncWebAssets by tasks.registering(Sync::class) {
    val repositoryRoot = rootProject.projectDir.parentFile

    from(File(repositoryRoot, "ui")) { into("ui") }
    from(File(repositoryRoot, "src")) { into("src") }

    into(layout.buildDirectory.dir("generated/webAssets"))
}

android {
    sourceSets {
        getByName("main") {
            assets.srcDir(layout.buildDirectory.dir("generated/webAssets"))
        }
    }
}

/**
 * Records what the release APK actually carries, so the notices can be checked
 * against it.
 *
 * The declared dependency list is not the shipped one. `androidx.activity` alone
 * drags in the whole androidx closure plus Kotlin and coroutines, from two
 * different copyright holders, and none of that appears in any build file.
 * Apache-2.0 attribution attaches to what is resolved, not to what is written
 * down, so the resolved set is what `npm test` compares the notices against.
 *
 * Regenerate with `gradlew :app:recordShippingDependencies` after any dependency
 * or version change, and commit the result.
 */
val recordShippingDependencies by tasks.registering {
    description = "Writes the resolved release runtime classpath to shipping-dependencies.json"

    val releaseClasspath = configurations.named("releaseRuntimeClasspath")
    val snapshot = File(projectDir.parentFile, "shipping-dependencies.json")

    doLast {
        // Resolved artifacts, not the resolution graph: a platform/BOM appears as
        // a component but contributes no file to the APK, and listing one as
        // shipped would be its own small inaccuracy.
        val coordinates = releaseClasspath.get().incoming.artifacts.artifacts
            .map { it.id.componentIdentifier }
            .filterIsInstance<org.gradle.api.artifacts.component.ModuleComponentIdentifier>()
            .map { "${it.group}:${it.module}:${it.version}" }
            .distinct()
            .sorted()

        val body = coordinates.joinToString(",\n") { "    \"$it\"" }
        snapshot.writeText(
            "{\n" +
                "  \"generatedBy\": \"gradlew :app:recordShippingDependencies\",\n" +
                "  \"configuration\": \"releaseRuntimeClasspath\",\n" +
                "  \"components\": [\n$body\n  ]\n" +
                "}\n"
        )
    }
}

// Every Android task that consumes the generated assets must see the Sync task
// as their producer.  Depending only from generate*Assets/merge*Assets misses
// the lint model tasks, which read the source-set directory directly; debug
// assembly therefore passed while lint and every release bundle failed Gradle's
// implicit-dependency validation.
tasks.matching {
    ((it.name.startsWith("generate") || it.name.startsWith("merge"))
        && it.name.endsWith("Assets"))
        || it.name.contains("lint", ignoreCase = true)
}.configureEach {
    dependsOn(syncWebAssets)
}

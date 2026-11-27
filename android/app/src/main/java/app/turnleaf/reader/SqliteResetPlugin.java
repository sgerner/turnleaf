package app.turnleaf.reader;

import android.content.Context;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

@CapacitorPlugin(name = "SqliteReset")
public class SqliteResetPlugin extends Plugin {
    private static final String DATABASE_FILE = "turnleafSQLite.db";
    private static final String[] ALLOWED_FILES = {
        DATABASE_FILE,
        DATABASE_FILE + "-wal",
        DATABASE_FILE + "-shm",
        DATABASE_FILE + "-journal",
    };

    @PluginMethod
    public void deleteDatabase(PluginCall call) {
        String requested = call.getString("database", "turnleaf");
        if (
            requested != null &&
            !requested.equals("turnleaf") &&
            !requested.equals(DATABASE_FILE)
        ) {
            call.reject("Unsupported database name.");
            return;
        }

        Context context = getContext();
        if (context == null) {
            call.reject("Android context is unavailable.");
            return;
        }

        for (String fileName : ALLOWED_FILES) {
            File target = context.getDatabasePath(fileName);
            if (target != null && target.exists() && !target.delete() && target.exists()) {
                call.reject("Could not delete " + fileName + ".");
                return;
            }
        }

        call.resolve();
    }
}

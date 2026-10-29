using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

class Launcher
{
    // Wird beim Build durch den SHA-256 des eingebetteten Archivs ersetzt.
    const string BuildId = "PAYLOAD_BUILD_ID";

    static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(c);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        bool selfTest = args.Length > 0 && args[0] == "--self-test";
        int code = 1;
        try
        {
            string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string app = Path.Combine(root, "WhatsApp-Backup-Dateien", BuildId);
            // Verhindert paralleles Entpacken desselben Pakets.
            string mutexId;
            using (var sha = System.Security.Cryptography.SHA256.Create())
                mutexId = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(app))).Replace("-", "");
            using (var mutex = new System.Threading.Mutex(false, "Local\\WhatsAppBackup-" + mutexId))
            {
                try { mutex.WaitOne(); }
                catch (System.Threading.AbandonedMutexException) { }
                try
                {
                    if (!File.Exists(Path.Combine(app, ".ready")))
                    {
                        Console.WriteLine("Richte WhatsApp-Backup ein (beim ersten Start) ...");
                        Directory.CreateDirectory(app);
                        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
                        using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
                        {
                            foreach (var entry in zip.Entries)
                            {
                                string target = Path.GetFullPath(Path.Combine(app, entry.FullName));
                                if (!target.StartsWith(app + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                                    throw new InvalidDataException("Ungültiger Archivpfad");
                                if (String.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(target); continue; }
                                Directory.CreateDirectory(Path.GetDirectoryName(target));
                                using (var source = entry.Open())
                                using (var dest = File.Create(target)) source.CopyTo(dest);
                            }
                        }
                        File.WriteAllText(Path.Combine(app, ".ready"), BuildId);
                    }
                }
                finally { mutex.ReleaseMutex(); }
            }
            string script = "menu.js";
            int skip = 0;
            if (selfTest) { script = "exe-self-test.js"; skip = 1; }
            else if (args.Length > 0 && args[0] == "--web") { script = "backup.js"; skip = 1; }
            else if (args.Length > 0 && args[0] == "--usb") { script = "usb-backup.js"; skip = 1; }
            var command = new StringBuilder(Quote(Path.Combine(app, script)));
            for (int i = skip; i < args.Length; i++) command.Append(" ").Append(Quote(args[i]));
            var start = new ProcessStartInfo(Path.Combine(app, "runtime", "node.exe"), command.ToString());
            start.UseShellExecute = false;
            start.WorkingDirectory = app;
            start.EnvironmentVariables["WHATSAPP_BACKUP_DIR"] = Path.Combine(root, "backup");
            start.EnvironmentVariables["PUPPETEER_EXECUTABLE_PATH"] = Path.Combine(app, "browser", "chrome.exe");
            using (var child = Process.Start(start)) { child.WaitForExit(); code = child.ExitCode; }
        }
        catch (Exception e) { Console.Error.WriteLine("Start fehlgeschlagen: " + e.Message); }
        if (args.Length == 0 && !Console.IsInputRedirected)
        {
            Console.WriteLine("\nZum Schließen eine Taste drücken ...");
            Console.ReadKey(true);
        }
        return code;
    }
}

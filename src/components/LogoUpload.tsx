import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Upload, X, Loader2 } from "lucide-react";
import { media } from "@/lib/api";
import { toast } from "sonner";

interface LogoUploadProps {
  currentLogoUrl?: string;
  onUpload: (url: string) => void;
  onRemove: () => void;
}

export const LogoUpload = ({ currentLogoUrl, onUpload, onRemove }: LogoUploadProps) => {
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast.error("Veuillez sélectionner une image");
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast.error("L'image ne doit pas dépasser 5 Mo");
      return;
    }

    setUploading(true);
    try {
      // The API owns the storage path and re-validates type and size itself.
      // The browser never names the destination, so it cannot write outside
      // its own account's media.
      const asset = await media.upload(file, "logo");
      onUpload(asset.url);
      toast.success("Logo envoyé.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur lors du téléchargement";
      toast.error(message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      {currentLogoUrl ? (
        <div className="relative inline-block">
          <img
            src={currentLogoUrl}
            alt="Logo entreprise"
            className="w-40 h-24 object-contain p-1 rounded-lg border border-border bg-muted"
          />
          <Button
            size="icon"
            variant="destructive"
            className="absolute -top-2 -right-2 h-6 w-6"
            onClick={onRemove}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="w-24 h-24 rounded-lg border-2 border-dashed border-border flex items-center justify-center bg-muted/50">
          <Upload className="h-8 w-8 text-muted-foreground" />
        </div>
      )}

      <div>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={handleUpload}
          className="hidden"
          id="logo-upload"
          disabled={uploading}
        />
        <label htmlFor="logo-upload">
          <Button
            variant="outline"
            size="sm"
            className="glass-card cursor-pointer"
            disabled={uploading}
            asChild
          >
            <span>
              {uploading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Envoi…
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  {currentLogoUrl ? "Changer le logo" : "Ajouter un logo"}
                </>
              )}
            </span>
          </Button>
        </label>
      </div>
    </div>
  );
};

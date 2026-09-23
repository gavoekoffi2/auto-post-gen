import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Lock, Trash2, Mail, Download } from "lucide-react";
import { account, auth } from "@/lib/api";
import { useSession } from "@/lib/session";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";

interface AccountSettingsProps {
  userEmail: string;
}

export function AccountSettings({ userEmail }: AccountSettingsProps) {
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  // The deletion dialog has its own password field: reusing the one from the
  // "change password" form above would mean typing your password into an
  // unrelated form to delete your account.
  const [deletePassword, setDeletePassword] = useState("");
  const CONFIRM_WORD = "SUPPRIMER";
  const { signOut } = useSession();

  const handleExport = async () => {
    setExporting(true);
    try {
      const data = await account.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mes-donnees-pro-social-ai.json";
      // Attached, and revoked only once the download has started: Firefox
      // ignores a click on a detached link, and revoking synchronously can
      // cancel the download in Safari.
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success("Vos données ont été téléchargées.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors de l'export";
      toast.error(message);
    } finally {
      setExporting(false);
    }
  };

  const handlePasswordChange = async () => {
    if (!currentPassword) {
      toast.error("Veuillez saisir votre mot de passe actuel");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("Le nouveau mot de passe doit contenir au moins 8 caractères");
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error("Les mots de passe ne correspondent pas");
      return;
    }

    setChangingPassword(true);
    try {
      // The current password goes with the change in one call: the server
      // verifies it before accepting the new one, so an unlocked session alone
      // cannot change the password and lock the owner out. Verifying in a
      // separate "log in again" round trip would leave a window between the
      // check and the change.
      await auth.changePassword(currentPassword, newPassword);

      toast.success("Mot de passe mis à jour !");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors du changement de mot de passe";
      toast.error(message);
    } finally {
      setChangingPassword(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!deletePassword) {
      toast.error("Saisissez votre mot de passe pour confirmer la suppression");
      return;
    }
    setDeleting(true);
    try {
      // Deleting an account is irreversible, so the server re-verifies the
      // password before doing it — a session left open on a shared machine is
      // not enough on its own. The API wipes media, app data and the account
      // row together, and clears the session cookie as part of the response.
      await account.remove(deletePassword);
      await signOut();

      toast.success("Compte supprimé. Au revoir !");
      navigate("/");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors de la suppression";
      toast.error(message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Email Info */}
      <Card className="glass-card p-6">
        <div className="flex items-center gap-2 mb-4">
          <Mail className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Adresse email</h2>
        </div>
        <p className="text-muted-foreground">{userEmail}</p>
        <p className="text-xs text-muted-foreground mt-2">
          Pour changer d'email, contactez le support.
        </p>
      </Card>

      {/* Password Change */}
      <Card className="glass-card p-6">
        <div className="flex items-center gap-2 mb-4">
          <Lock className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Changer le mot de passe</h2>
        </div>

        <div className="space-y-4 max-w-md">
          <div className="space-y-2">
            <Label>Mot de passe actuel</Label>
            <Input
              type="password"
              placeholder="••••••••"
              className="glass-card"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Nouveau mot de passe</Label>
            <Input
              type="password"
              placeholder="••••••••"
              className="glass-card"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Confirmer le mot de passe</Label>
            <Input
              type="password"
              placeholder="••••••••"
              className="glass-card"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          <Button
            onClick={handlePasswordChange}
            disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}
          >
            {changingPassword ? "Mise à jour..." : "Mettre à jour"}
          </Button>
        </div>
      </Card>

      {/* Data export (GDPR) */}
      <Card className="glass-card p-6">
        <div className="flex items-center gap-2 mb-4">
          <Download className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Mes données</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Téléchargez une copie de vos données (profil, posts, commentaires,
          comptes connectés) au format JSON.
        </p>
        <Button variant="outline" className="glass-card" onClick={handleExport} disabled={exporting}>
          <Download className="w-4 h-4 mr-2" />
          {exporting ? "Préparation…" : "Télécharger mes données"}
        </Button>
      </Card>

      {/* Delete Account */}
      <Card className="glass-card p-6 border-destructive/50">
        <div className="flex items-center gap-2 mb-4">
          <Trash2 className="w-5 h-5 text-destructive" />
          <h2 className="text-lg font-semibold text-destructive">Zone de danger</h2>
        </div>

        <p className="text-sm text-muted-foreground mb-4">
          La suppression de votre compte est irréversible. Toutes vos données, 
          posts et paramètres seront définitivement effacés.
        </p>

        <AlertDialog onOpenChange={(open) => !open && setConfirmText("")}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" disabled={deleting}>
              <Trash2 className="w-4 h-4 mr-2" />
              Supprimer mon compte
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Êtes-vous sûr ?</AlertDialogTitle>
              <AlertDialogDescription>
                Cette action est irréversible. Votre compte et toutes vos données
                seront définitivement supprimés. Pour confirmer, tapez{" "}
                <strong>{CONFIRM_WORD}</strong> puis votre mot de passe.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={CONFIRM_WORD}
              aria-label="Confirmation de suppression"
              className="glass-card"
            />
            <Input
              type="password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              placeholder="Votre mot de passe"
              aria-label="Mot de passe pour confirmer la suppression"
              className="glass-card"
            />
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setDeletePassword("")}>Annuler</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDeleteAccount}
                disabled={deleting || confirmText !== CONFIRM_WORD || !deletePassword}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleting ? "Suppression..." : "Supprimer définitivement"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Card>
    </div>
  );
}

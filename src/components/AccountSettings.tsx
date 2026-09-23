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
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { functionErrorMessage } from "@/lib/functionError";
import { PASSWORD_RULE_HINT, validatePassword } from "@/lib/password";
import { useNavigate } from "react-router-dom";
import { authErrorMessage } from "@/lib/authError";

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
  const [newEmail, setNewEmail] = useState("");
  const [changingEmail, setChangingEmail] = useState(false);
  const CONFIRM_WORD = "SUPPRIMER";

  // Self-service email change. Previously the screen said "contactez le
  // support" — which asks a user to email an address they may not be able to
  // reach, to fix the very address they cannot reach. Supabase sends a
  // confirmation to the NEW address and only swaps auth.users.email once it is
  // clicked, and a trigger keeps profiles.email (used to send the weekly
  // validation emails) in step with it.
  const handleEmailChange = async () => {
    const address = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      toast.error("Saisissez une adresse email valide.");
      return;
    }
    if (address === userEmail.trim().toLowerCase()) {
      toast.error("C'est déjà votre adresse actuelle.");
      return;
    }

    setChangingEmail(true);
    try {
      const { error } = await supabase.auth.updateUser(
        { email: address },
        { emailRedirectTo: `${window.location.origin}/profile` },
      );
      if (error) throw error;
      setNewEmail("");
      toast.success(
        `Un lien de confirmation a été envoyé à ${address}. Votre adresse actuelle reste active tant qu'il n'est pas ouvert.`,
        { duration: 12000 },
      );
    } catch (error: unknown) {
      toast.error(authErrorMessage(error, "Changement d'adresse impossible."));
    } finally {
      setChangingEmail(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const { data, error } = await supabase.functions.invoke("export-account-data", {});
      if (error) throw error;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mes-donnees-pro-social-ai.json";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Vos données ont été téléchargées.");
    } catch (error: unknown) {
      toast.error(await functionErrorMessage(error, "Erreur lors de l'export"));
    } finally {
      setExporting(false);
    }
  };

  const handlePasswordChange = async () => {
    if (!currentPassword) {
      toast.error("Veuillez saisir votre mot de passe actuel");
      return;
    }
    const passwordError = validatePassword(newPassword, confirmPassword);
    if (passwordError) {
      toast.error(passwordError);
      return;
    }

    setChangingPassword(true);
    try {
      // Re-authenticate first so a stolen/unlocked session can't silently
      // change the password and lock out the owner.
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email: userEmail,
        password: currentPassword,
      });
      if (reauthError) {
        toast.error("Mot de passe actuel incorrect");
        return;
      }

      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) throw error;

      toast.success("Mot de passe mis à jour !");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error: unknown) {
      toast.error(authErrorMessage(error, "Erreur lors du changement de mot de passe."));
    } finally {
      setChangingPassword(false);
    }
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Non authentifié");

      // The edge function uses the admin API to wipe storage, app data
      // AND the auth.users row in a single transaction.
      const { error } = await supabase.functions.invoke("delete-account", {});
      if (error) throw error;

      await supabase.auth.signOut();

      toast.success("Compte supprimé. Au revoir !");
      navigate("/");
    } catch (error: unknown) {
      toast.error(await functionErrorMessage(error, "Erreur lors de la suppression"));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Email */}
      <Card className="glass-card p-6">
        <div className="flex items-center gap-2 mb-4">
          <Mail className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Adresse email</h2>
        </div>
        <p className="text-muted-foreground mb-4">{userEmail}</p>

        <div className="space-y-4 max-w-md">
          <div className="space-y-2">
            <Label>Nouvelle adresse email</Label>
            <Input
              type="email"
              placeholder="nouvelle@adresse.com"
              className="glass-card"
              autoComplete="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Un lien de confirmation est envoyé à la nouvelle adresse. Le changement
              ne prend effet qu'une fois ce lien ouvert — votre adresse actuelle reste
              active jusque-là.
            </p>
          </div>
          <Button
            variant="outline"
            className="glass-card"
            onClick={handleEmailChange}
            disabled={changingEmail || !newEmail.trim()}
          >
            {changingEmail ? "Envoi…" : "Changer d'adresse"}
          </Button>
        </div>
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
            <p className="text-xs text-muted-foreground">{PASSWORD_RULE_HINT}</p>
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
                <strong>{CONFIRM_WORD}</strong> ci-dessous.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={CONFIRM_WORD}
              aria-label="Confirmation de suppression"
              className="glass-card"
            />
            <AlertDialogFooter>
              <AlertDialogCancel>Annuler</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDeleteAccount}
                disabled={deleting || confirmText !== CONFIRM_WORD}
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
